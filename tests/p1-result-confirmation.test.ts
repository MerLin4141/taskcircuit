// Guards against duplicate results and unknown outcomes after committed responses are lost.
import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapter.js";
import { DatabaseSync } from "node:sqlite";

type Hub = ReturnType<typeof createHub>;
const post = (hub: Hub, url: string, payload: unknown) =>
  hub.inject({ method: "POST", url, payload });
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, value]) => `${JSON.stringify(k)}:${canonical(value)}`)
      .join(",")}}`;
  return JSON.stringify(v);
};
const digest = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "tc-p1-receipt-"));
  let now = Date.parse("2026-01-01T00:00:00Z");
  let hub = createHub(join(root, "db"), defaultConfig, () => now, 0, {
    dispatcherPollMs: 0,
  });
  const base = await hub.listen({ port: 0, host: "127.0.0.1" });
  const created = (
    await post(hub, "/api/events", {
      source: "local",
      type: "demo.retry",
      payload: {},
    })
  ).json();
  const claim = (
    await post(hub, "/api/executions/claim", { workerId: "w" })
  ).json();
  return {
    root,
    get hub() {
      return hub;
    },
    base,
    created,
    claim,
    advance(ms: number) {
      now += ms;
    },
    async restart() {
      await hub.close();
      hub = createHub(join(root, "db"), defaultConfig, () => now, 0, {
        dispatcherPollMs: 0,
      });
    },
    async close() {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const resultCases = [
  [
    "complete",
    { type: "completed", sessionId: "private-session", output: "ok" },
  ],
  [
    "ask",
    {
      type: "needs_input",
      sessionId: "private-session",
      request: { title: "q", text: "q", key: "q", options: ["yes"] },
    },
  ],
  [
    "later",
    {
      type: "later",
      sessionId: "private-session",
      message: "wait",
      afterSeconds: 2,
    },
  ],
  [
    "retry",
    {
      type: "failed",
      sessionId: "private-session",
      error: {
        code: "agent_execution",
        message: "pre-start",
        retryable: true,
        safeToRetry: true,
      },
    },
  ],
] as const;
const identity = (
  claim: any,
  result: unknown,
  submissionId = randomUUID(),
) => ({
  workerId: "w",
  leaseToken: claim.leaseToken,
  submissionId,
  resultDigest: digest(result),
  result,
});

describe("result submission receipt", () => {
  it("preserves legacy submission and duplicate conflict behavior without creating a receipt", async () => {
    const f = await setup();
    try {
      const result = resultCases[0][1];
      const payload = { workerId: "w", leaseToken: f.claim.leaseToken, result };
      const url = `/api/executions/${f.claim.execution.id}/result`;
      const first = await post(f.hub, url, payload);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true });
      expect((await post(f.hub, url, payload)).statusCode).toBe(409);
      const query = await f.hub.inject(
        `/api/executions/${f.claim.execution.id}/result-submissions/${randomUUID()}?digest=${digest(result)}`,
      );
      expect(query.statusCode).toBe(200);
      expect(query.json().status).toBe("not_found");
    } finally {
      await f.close();
    }
  });
  it.each(resultCases)(
    "commits and replays %s exactly once, including across restart",
    async (_kind, result) => {
      const f = await setup();
      try {
        const body = identity(f.claim, result);
        const url = `/api/executions/${f.claim.execution.id}/result`;
        const first = await post(f.hub, url, body);
        expect(first.statusCode).toBe(200);
        expect(first.json().status).toBe("accepted");
        const before = (
          await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
        ).json();
        const notes = (await f.hub.inject("/api/notifications")).json();
        const replay = await post(f.hub, url, body);
        expect(replay.statusCode).toBe(200);
        expect(replay.json().status).toBe("already_committed");
        expect(
          (
            await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
          ).json(),
        ).toEqual(before);
        expect((await f.hub.inject("/api/notifications")).json()).toEqual(
          notes,
        );
        expect(JSON.stringify(replay.json())).not.toContain("private-session");
        expect(JSON.stringify(replay.json())).not.toContain(f.claim.leaseToken);
        await f.restart();
        const confirmed = await f.hub.inject(
          `/api/executions/${f.claim.execution.id}/result-submissions/${body.submissionId}?digest=${body.resultDigest}`,
        );
        expect(confirmed.statusCode).toBe(200);
        expect(confirmed.json().status).toBe("committed");
        expect(JSON.stringify(confirmed.json())).not.toContain(
          "private-session",
        );
        const afterRestart = await post(f.hub, url, body);
        expect(afterRestart.statusCode).toBe(200);
        expect(afterRestart.json().status).toBe("already_committed");
        if (_kind === "ask") {
          const item = (
            await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
          ).json();
          expect(item.interactions).toHaveLength(1);
          expect(
            (
              await post(
                f.hub,
                `/api/interactions/${item.interactions[0].id}/answer`,
                { answer: "yes" },
              )
            ).statusCode,
          ).toBe(200);
        } else if (_kind === "later" || _kind === "retry") {
          f.advance(3000);
          expect(f.hub.tickScheduler()).toBe(1);
          expect(f.hub.tickScheduler()).toBe(0);
          const db = new DatabaseSync(join(f.root, "db"), { readOnly: true });
          try {
            expect(
              Number(
                db.prepare("SELECT COUNT(*) AS n FROM schedule_firings").get()
                  ?.n,
              ),
            ).toBe(1);
          } finally {
            db.close();
          }
        }
        if (_kind !== "complete") {
          const resumed = (
            await post(f.hub, "/api/executions/claim", { workerId: "next" })
          ).json();
          expect(resumed.execution.sequence).toBe(2);
          expect(resumed.agentSession.externalSessionId).toBe(
            "private-session",
          );
          expect(resumed.execution.agentSessionId).toBe(before.agentSession.id);
        }
      } finally {
        await f.close();
      }
    },
  );
  it("uses a stable canonical digest for differently ordered result fields", async () => {
    const f = await setup();
    try {
      const result = {
        type: "needs_input",
        sessionId: "same",
        request: { title: "q", text: "q", key: "q", options: ["yes"] },
      };
      const reordered = {
        request: { options: ["yes"], key: "q", text: "q", title: "q" },
        sessionId: "same",
        type: "needs_input",
      };
      const body = identity(f.claim, result);
      const url = `/api/executions/${f.claim.execution.id}/result`;
      expect(digest(result)).toBe(digest(reordered));
      expect((await post(f.hub, url, body)).statusCode).toBe(200);
      const replay = await post(f.hub, url, { ...body, result: reordered });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().status).toBe("already_committed");
      expect(
        (await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)).json()
          .interactions,
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it("rejects an identical submission id with changed content without modifying state", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await setup();
    try {
      const a = identity(f.claim, resultCases[0][1]);
      const url = `/api/executions/${f.claim.execution.id}/result`;
      expect((await post(f.hub, url, a)).statusCode).toBe(200);
      const before = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      const changed = { ...resultCases[0][1], output: "different" };
      expect(
        (await post(f.hub, url, { ...a, result: changed })).statusCode,
      ).toBe(409);
      expect(
        (
          await post(f.hub, url, {
            ...a,
            result: changed,
            resultDigest: digest(changed),
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)).json(),
      ).toEqual(before);
      expect(JSON.stringify(log.mock.calls)).toContain(
        "result_submission_conflict",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(a.leaseToken);
      expect(JSON.stringify(log.mock.calls)).not.toContain("private-session");
      const conflict = await f.hub.inject(
        `/api/executions/${f.claim.execution.id}/result-submissions/${a.submissionId}?digest=${digest(changed)}`,
      );
      expect(conflict.statusCode).toBe(409);
      expect(JSON.stringify(log.mock.calls)).toContain(
        "result_receipt_conflict",
      );
    } finally {
      log.mockRestore();
      await f.close();
    }
  });
  it("rejects a stale new result but lets a stale sender query the accepted receipt", async () => {
    const a = await setup();
    try {
      const valid = identity(a.claim, resultCases[0][1]);
      expect(
        (
          await post(
            a.hub,
            `/api/executions/${a.claim.execution.id}/result`,
            valid,
          )
        ).statusCode,
      ).toBe(200);
      a.advance(31000);
      const replay = await post(
        a.hub,
        `/api/executions/${a.claim.execution.id}/result`,
        valid,
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.json().status).toBe("already_committed");
      const fresh = identity(a.claim, resultCases[0][1]);
      expect(
        (
          await post(
            a.hub,
            `/api/executions/${a.claim.execution.id}/result`,
            fresh,
          )
        ).statusCode,
      ).toBe(409);
    } finally {
      await a.close();
    }
    const b = await setup();
    try {
      b.advance(31000);
      const fresh = identity(b.claim, resultCases[0][1]);
      expect(
        (
          await post(
            b.hub,
            `/api/executions/${b.claim.execution.id}/result`,
            fresh,
          )
        ).statusCode,
      ).toBe(409);
    } finally {
      await b.close();
    }
  });
});

describe("result response recovery", () => {
  it("stops after bounded reconciliation when the Hub cannot be reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-p1-offline-"));
    let now = Date.parse("2026-01-01T00:00:00Z");
    const hub = createHub(join(root, "db"), defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    const original = globalThis.fetch;
    let calls = 0,
      posts = 0,
      queries = 0;
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      const created = (
        await post(hub, "/api/events", {
          source: "local",
          type: "demo.retry",
          payload: {},
        })
      ).json();
      globalThis.fetch = async (...args) => {
        if (String(args[0]).endsWith("/result")) {
          posts++;
          throw new Error("offline");
        }
        if (String(args[0]).includes("/result-submissions/")) {
          queries++;
          throw new Error("offline");
        }
        return original(...args);
      };
      const adapter: AgentAdapter = {
        async execute() {
          calls++;
          return { type: "completed", sessionId: "fake", output: "done" };
        },
      };
      await expect(workOnce(base, "w", adapter)).rejects.toThrow("无法确认");
      expect(calls).toBe(1);
      expect(posts).toBeLessThanOrEqual(3);
      expect(queries).toBeLessThanOrEqual(3);
      now += 31000;
      expect(
        (await post(hub, "/api/executions/claim", { workerId: "other" }))
          .statusCode,
      ).toBe(204);
      const state = (
        await hub.inject(`/api/work-items/${created.workItem.id}`)
      ).json();
      expect(state.executions).toHaveLength(1);
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
    } finally {
      globalThis.fetch = original;
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["after_commit", "before_commit", "body_lost"] as const)(
    "confirms or retries with the same identity when response is lost %s",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "tc-p1-response-"));
      const hub = createHub(join(root, "db"), defaultConfig, undefined, 0, {
        dispatcherPollMs: 0,
      });
      const original = globalThis.fetch;
      let calls = 0,
        resultPosts = 0,
        queries = 0;
      const ids: string[] = [];
      try {
        const base = await hub.listen({ port: 0, host: "127.0.0.1" });
        const created = (
          await post(hub, "/api/events", {
            source: "local",
            type: "demo.retry",
            payload: {},
          })
        ).json();
        const adapter: AgentAdapter = {
          async execute() {
            calls++;
            return { type: "completed", sessionId: "fake", output: "done" };
          },
        };
        globalThis.fetch = async (...args) => {
          const path = String(args[0]);
          if (path.includes("/result-submissions/")) queries++;
          if (path.endsWith("/result")) {
            resultPosts++;
            const body = JSON.parse(String(args[1]?.body));
            ids.push(body.submissionId);
            if (resultPosts === 1) {
              if (mode !== "before_commit") await original(...args);
              if (mode === "body_lost")
                return new Response("{", { status: 200 });
              throw new Error("injected response loss");
            }
          }
          return original(...args);
        };
        expect(await workOnce(base, "w", adapter)).toBe(true);
        expect(calls).toBe(1);
        expect(queries).toBeGreaterThanOrEqual(1);
        expect(resultPosts).toBe(mode === "before_commit" ? 2 : 1);
        expect(new Set(ids).size).toBe(1);
        expect(ids[0]).toBeTruthy();
        const state = (
          await hub.inject(`/api/work-items/${created.workItem.id}`)
        ).json();
        expect(state.workItem.status).toBe("completed");
        expect(state.executions).toHaveLength(1);
      } finally {
        globalThis.fetch = original;
        await hub.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
