// Guards real v0.1.1 database upgrades, multi-execution receipts, and schedule recovery.
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { resultDigest } from "../src/result-receipt.js";
import { formatWorkItem } from "../src/cli-format.js";
import { workOnce } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapter.js";

type Hub = ReturnType<typeof createHub>;
type RecordId = { workId: string; executionId: string };
type FixtureData = {
  generatedByCommit: string;
  clock: number;
  empty: { sha256: string; gzipBase64: string };
  history: { sha256: string; gzipBase64: string };
  items: Record<string, RecordId>;
};
const saved = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "v011-databases.json"),
    "utf8",
  ),
) as FixtureData;
const post = (hub: Hub, url: string, payload: unknown) =>
  hub.inject({ method: "POST", url, payload });
const item = async (hub: Hub, id: string) =>
  (await hub.inject(`/api/work-items/${id}`)).json();
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("fixture timed out");
    await tick();
  }
}
function setup(kind: "empty" | "history") {
  expect(saved.generatedByCommit).toBe(
    "4fb7cf13fd7c243c8d2bd82ece34f75ae37a55df",
  );
  const root = mkdtempSync(join(tmpdir(), "tc-v011-compat-"));
  const path = join(root, "db");
  const raw = gunzipSync(Buffer.from(saved[kind].gzipBase64, "base64"));
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    saved[kind].sha256,
  );
  writeFileSync(path, raw);
  let now = saved.clock;
  let hub = createHub(path, defaultConfig, () => now, 0, {
    dispatcherPollMs: 0,
  });
  return {
    root,
    path,
    get hub() {
      return hub;
    },
    advance(ms: number) {
      now += ms;
    },
    time() {
      return now;
    },
    async restart() {
      await hub.close();
      hub = createHub(path, defaultConfig, () => now, 0, {
        dispatcherPollMs: 0,
      });
    },
    async close() {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function dbCount(path: string, sql: string, ...args: string[]) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare(sql).get(...args)?.n);
  } finally {
    db.close();
  }
}
const ask = {
  type: "needs_input",
  sessionId: "perf-session",
  request: { title: "q", text: "q", key: "q", options: ["yes"] },
};

describe("genuine v0.1.1 database compatibility", () => {
  it("opens an actual empty v0.1.1 database with the original schema versions", async () => {
    const f = setup("empty");
    try {
      expect((await f.hub.inject("/api/health")).statusCode).toBe(200);
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM schema_migrations"),
      ).toBe(4);
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM work_items"),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("reads genuine completed, Ask, Later, Retry, running, session and old error records", async () => {
    const f = setup("history");
    try {
      const expected: Record<string, string> = {
        completed: "completed",
        ask: "waiting_input",
        later: "waiting_schedule",
        retry: "waiting_schedule",
        failed: "failed",
        running: "active",
      };
      for (const [name, status] of Object.entries(expected))
        expect(
          (await item(f.hub, saved.items[name].workId)).workItem.status,
        ).toBe(status);
      const complete = await item(f.hub, saved.items.completed.workId);
      expect(complete.agentSession.externalSessionId).toBe(
        "legacy-complete-session",
      );
      expect(
        complete.workItem.metadata.taskcircuitResultReceiptsV1,
      ).toBeUndefined();
      expect(
        (await item(f.hub, saved.items.ask.workId)).agentSession
          .externalSessionId,
      ).toBe("legacy-ask-session");
      expect(
        (await item(f.hub, saved.items.later.workId)).agentSession
          .externalSessionId,
      ).toBe("legacy-later-session");
      const retry = await item(f.hub, saved.items.retry.workId);
      expect(retry.agentSession.externalSessionId).toBe("legacy-retry-session");
      expect(retry.executions[0].error).toMatchObject({
        code: "agent_execution",
        message: "legacy retry",
        retryable: true,
      });
      expect(retry.schedules).toHaveLength(1);
      const failed = await item(f.hub, saved.items.failed.workId);
      expect(failed.executions[0].error).toMatchObject({
        code: "agent_execution",
        message: "legacy terminal",
      });
      expect(formatWorkItem(failed)).toContain("agent_execution");
      expect(JSON.stringify(retry)).not.toContain("leaseToken");
    } finally {
      await f.close();
    }
  });
  it("answers a persisted Ask once after restart and resumes the same historical session with a receipt", async () => {
    const f = setup("history");
    const id = saved.items.ask.workId;
    try {
      // Inject an unknown extension into a copy of the genuine historical row.
      const extensionDb = new DatabaseSync(f.path);
      const oldMetadata = JSON.parse(
        String(
          extensionDb
            .prepare("SELECT metadata FROM work_items WHERE id=?")
            .get(id)!.metadata,
        ),
      );
      extensionDb
        .prepare("UPDATE work_items SET metadata=? WHERE id=?")
        .run(
          JSON.stringify({ ...oldMetadata, futureExtension: { version: 7 } }),
          id,
        );
      extensionDb.close();
      await f.restart();
      let state = await item(f.hub, id);
      const sessionId = state.agentSession.id;
      const interaction = state.interactions[0];
      expect(interaction.status).toBe("open");
      expect(
        (
          await post(f.hub, `/api/interactions/${interaction.id}/answer`, {
            answer: "yes",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(f.hub, `/api/interactions/${interaction.id}/answer`, {
            answer: "yes",
          })
        ).statusCode,
      ).toBe(409);
      const base = await f.hub.listen({ port: 0, host: "127.0.0.1" });
      const seen: string[] = [];
      const adapter: AgentAdapter = {
        async execute(input) {
          seen.push(input.externalSessionId ?? "");
          return {
            type: "completed",
            sessionId: input.externalSessionId!,
            output: "resumed",
          };
        },
      };
      expect(await workOnce(base, "new-worker", adapter)).toBe(true);
      state = await item(f.hub, id);
      expect(seen).toEqual(["legacy-ask-session"]);
      expect(state.agentSession.id).toBe(sessionId);
      expect(state.agentSession.externalSessionId).toBe("legacy-ask-session");
      expect(state.interactions).toHaveLength(1);
      expect(state.interactions[0]).toMatchObject({
        id: interaction.id,
        status: "resolved",
        response: "yes",
      });
      expect(state.executions.map((e: any) => e.sequence)).toEqual([1, 2]);
      expect(state.workItem.status).toBe("completed");
      expect(state.workItem.metadata.futureExtension).toEqual({ version: 7 });
      const receipt =
        state.workItem.metadata.taskcircuitResultReceiptsV1[
          state.executions[1].id
        ];
      expect(receipt.executionId).toBe(state.executions[1].id);
      expect(JSON.stringify(receipt)).not.toContain("legacy-ask-session");
    } finally {
      await f.close();
    }
  });
  it("does not fire a cancelled historical Later schedule after restart", async () => {
    const f = setup("history");
    try {
      for (const name of ["later", "retry"]) {
        expect(
          (
            await post(
              f.hub,
              `/api/work-items/${saved.items[name].workId}/cancel`,
              {},
            )
          ).statusCode,
        ).toBe(200);
      }
      await f.restart();
      f.advance(2000);
      expect(f.hub.tickScheduler()).toBe(0);
      const state = await item(f.hub, saved.items.later.workId);
      expect(state.workItem.status).toBe("cancelled");
      expect(state.executions).toHaveLength(1);
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM schedule_firings"),
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("restarts an overdue Later once at the deadline and resumes the historical session", async () => {
    const f = setup("history");
    const id = saved.items.later.workId;
    try {
      expect(
        (
          await post(
            f.hub,
            `/api/work-items/${saved.items.retry.workId}/cancel`,
            {},
          )
        ).statusCode,
      ).toBe(200);
      await f.restart();
      f.advance(1999);
      expect(f.hub.tickScheduler()).toBe(0);
      f.advance(1);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(f.hub.tickScheduler()).toBe(0);
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM schedule_firings"),
      ).toBe(1);
      const base = await f.hub.listen({ port: 0, host: "127.0.0.1" });
      const seen: string[] = [];
      const adapter: AgentAdapter = {
        async execute(input) {
          seen.push(input.externalSessionId ?? "");
          return {
            type: "completed",
            sessionId: input.externalSessionId!,
            output: "later done",
          };
        },
      };
      expect(await workOnce(base, "later-worker", adapter)).toBe(true);
      const state = await item(f.hub, id);
      expect(seen).toEqual(["legacy-later-session"]);
      expect(state.workItem.status).toBe("completed");
      expect(state.executions.map((e: any) => e.sequence)).toEqual([1, 2]);
      expect(state.executions[0].agentSessionId).toBe(
        state.executions[1].agentSessionId,
      );
      expect(
        Object.keys(state.workItem.metadata.taskcircuitResultReceiptsV1),
      ).toEqual([state.executions[1].id]);
    } finally {
      await f.close();
    }
  });
  it("recovers Later after the Worker crashes after committing its schedule", async () => {
    const f = setup("empty");
    let first: ChildProcess | undefined;
    let second: ChildProcess | undefined;
    const launch = (base: string, mode: string) => {
      const child = spawn(
        process.execPath,
        [
          join(process.cwd(), "tests", "fixtures", "v011-later-worker.mjs"),
          base,
          mode,
        ],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          env: {
            ...process.env,
            TASKCIRCUIT_HOME: join(f.root, "home"),
            TASKCIRCUIT_WORKSPACE_ROOT: join(f.root, "workspace"),
          },
        },
      );
      const messages: any[] = [];
      const completed = new Promise<any[]>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("fake worker timed out")),
          5000,
        );
        child.on("message", (message: any) => {
          messages.push(message);
          if (message.type === "error") {
            clearTimeout(timer);
            reject(new Error(message.message));
          }
          if (
            (mode === "commit-and-crash" && message.type === "committed") ||
            (mode === "resume" && message.type === "done")
          ) {
            clearTimeout(timer);
            resolve(messages);
          }
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return { child, completed };
    };
    const stop = async (child: ChildProcess | undefined) => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    };
    try {
      const base = await f.hub.listen({ port: 0, host: "127.0.0.1" });
      const created = (
        await post(f.hub, "/api/events", {
          source: "local",
          type: "demo.later",
          payload: {},
        })
      ).json();
      const a = launch(base, "commit-and-crash");
      first = a.child;
      const messages = await a.completed;
      expect(messages.find((m) => m.type === "committed").status).toBe(200);
      expect(messages.find((m) => m.type === "agent-input").session).toBeNull();
      await stop(first);
      await f.restart();
      f.advance(2000);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(f.hub.tickScheduler()).toBe(0);
      const nextBase = await f.hub.listen({ port: 0, host: "127.0.0.1" });
      const b = launch(nextBase, "resume");
      second = b.child;
      const resumed = await b.completed;
      expect(resumed.find((m) => m.type === "agent-input").session).toBe(
        "worker-restart-session",
      );
      const state = await item(f.hub, created.workItem.id);
      expect(state.workItem.status).toBe("completed");
      expect(state.executions.map((e: any) => e.sequence)).toEqual([1, 2]);
      expect(state.executions[0].agentSessionId).toBe(
        state.executions[1].agentSessionId,
      );
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM schedule_firings"),
      ).toBe(1);
    } finally {
      await stop(first);
      await stop(second);
      await f.close();
    }
  }, 15000);
  it("stops an old retry without proof of safe startup and preserves the old classification", async () => {
    const f = setup("history");
    const id = saved.items.retry.workId;
    try {
      await post(
        f.hub,
        `/api/work-items/${saved.items.later.workId}/cancel`,
        {},
      );
      await f.restart();
      f.advance(2000);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(f.hub.tickScheduler()).toBe(0);
      const state = await item(f.hub, id);
      expect(state.executions).toHaveLength(1);
      expect(state.executions[0].error).toMatchObject({
        code: "execution_outcome_unknown",
        causeCode: "agent_execution",
      });
      expect(state.agentSession.externalSessionId).toBe("legacy-retry-session");
      expect(state.workItem.status).toBe("failed");
      expect(state.schedules[0].status).toBe("cancelled");
      expect(formatWorkItem(state)).toContain("执行结果需要核实");
    } finally {
      await f.close();
    }
  });
  it("does not re-execute a v0.1.1 running task after lease expiration and restart", async () => {
    const f = setup("history");
    const id = saved.items.running.workId;
    try {
      f.advance(31000);
      f.hub.tickScheduler();
      let state = await item(f.hub, id);
      expect(state.executions).toHaveLength(1);
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
      await f.restart();
      state = await item(f.hub, id);
      expect(state.executions).toHaveLength(1);
      expect(state.workItem.status).toBe("failed");
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
    } finally {
      await f.close();
    }
  });
  it("continues scheduling when an active stale schedule already has the same firing", async () => {
    const f = setup("history");
    const id = saved.items.later.workId;
    try {
      await post(
        f.hub,
        `/api/work-items/${saved.items.retry.workId}/cancel`,
        {},
      );
      f.advance(2000);
      f.hub.tickScheduler();
      const claim = (
        await post(f.hub, "/api/executions/claim", { workerId: "resume" })
      ).json();
      expect(claim.execution.workItemId).toBe(id);
      expect(
        (
          await post(f.hub, `/api/executions/${claim.execution.id}/result`, {
            workerId: "resume",
            leaseToken: claim.leaseToken,
            result: {
              type: "completed",
              sessionId: "legacy-later-session",
              output: "done",
            },
          })
        ).statusCode,
      ).toBe(200);
      const state = await item(f.hub, id);
      const schedule = state.schedules[0];
      const db = new DatabaseSync(f.path);
      try {
        db.prepare(
          "UPDATE schedules SET status='active', next_fire_at=? WHERE id=?",
        ).run(new Date(f.time()).toISOString(), schedule.id);
      } finally {
        db.close();
      }
      f.hub.tickScheduler();
      const after = await item(f.hub, id);
      expect(after.workItem.status).toBe("completed");
      expect(after.executions).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it("does not reactivate a completed Work Item from a stale schedule with a new due time", async () => {
    const f = setup("history");
    const id = saved.items.later.workId;
    try {
      await post(
        f.hub,
        `/api/work-items/${saved.items.retry.workId}/cancel`,
        {},
      );
      f.advance(2000);
      f.hub.tickScheduler();
      const claim = (
        await post(f.hub, "/api/executions/claim", { workerId: "resume" })
      ).json();
      expect(claim.execution.workItemId).toBe(id);
      expect(
        (
          await post(f.hub, `/api/executions/${claim.execution.id}/result`, {
            workerId: "resume",
            leaseToken: claim.leaseToken,
            result: {
              type: "completed",
              sessionId: "legacy-later-session",
              output: "done",
            },
          })
        ).statusCode,
      ).toBe(200);
      const state = await item(f.hub, id);
      const schedule = state.schedules[0];
      f.advance(1);
      const db = new DatabaseSync(f.path);
      try {
        db.prepare(
          "UPDATE schedules SET status='active', next_fire_at=? WHERE id=?",
        ).run(new Date(f.time()).toISOString(), schedule.id);
      } finally {
        db.close();
      }
      f.hub.tickScheduler();
      const after = await item(f.hub, id);
      expect(after.workItem.status).toBe("completed");
      expect(after.executions).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
  it("survives a process killed inside the real migration transaction when reopening a v0.1.1 database", async () => {
    const f = setup("history");
    await f.hub.close();
    let child: ChildProcess | undefined;
    let reopened: Hub | undefined;
    const marker = join(f.root, "inside-migration");
    try {
      child = spawn(
        process.execPath,
        [
          join(process.cwd(), "tests", "fixtures", "v011-upgrade-kill.mjs"),
          f.path,
          marker,
          String(f.time()),
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      let stderr = "";
      child.stderr?.on("data", (data) => (stderr += String(data)));
      await until(() => existsSync(marker) || child!.exitCode !== null);
      if (!existsSync(marker))
        throw new Error(`upgrade child failed before transaction: ${stderr}`);
      await new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
        child!.kill();
      });
      reopened = createHub(f.path, defaultConfig, () => f.time(), 0, {
        dispatcherPollMs: 0,
      });
      expect(
        (await item(reopened, saved.items.ask.workId)).agentSession
          .externalSessionId,
      ).toBe("legacy-ask-session");
      expect(
        (await item(reopened, saved.items.later.workId)).schedules,
      ).toHaveLength(1);
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM schema_migrations"),
      ).toBe(4);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child!.once("exit", () => resolve());
          child!.kill();
        });
      }
      if (reopened) await reopened.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 15000);
});

describe("safe retry after upgrading v0.1.1", () => {
  it("resumes the same session across two proven-safe retries with fixed backoff", async () => {
    const f = setup("empty");
    try {
      const base = await f.hub.listen({ port: 0, host: "127.0.0.1" });
      const created = (
        await post(f.hub, "/api/events", {
          source: "local",
          type: "demo.retry",
          payload: {},
        })
      ).json();
      const sessions: Array<string | null> = [];
      const adapter: AgentAdapter = {
        async execute(input) {
          sessions.push(input.externalSessionId);
          if (sessions.length < 3)
            return {
              type: "failed",
              sessionId: "safe-fixture-session",
              error: {
                code: "agent_execution",
                message: "proven safe by fake fixture",
                retryable: true,
                safeToRetry: true,
              },
            };
          return {
            type: "completed",
            sessionId: input.externalSessionId!,
            output: "finished",
          };
        },
      };
      expect(await workOnce(base, "safe-one", adapter)).toBe(true);
      f.advance(1999);
      expect(f.hub.tickScheduler()).toBe(0);
      f.advance(1);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(await workOnce(base, "safe-two", adapter)).toBe(true);
      f.advance(1999);
      expect(f.hub.tickScheduler()).toBe(0);
      f.advance(1);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(await workOnce(base, "safe-three", adapter)).toBe(true);
      const state = await item(f.hub, created.workItem.id);
      expect(state.workItem.status).toBe("completed");
      expect(state.executions.map((e: any) => e.sequence)).toEqual([1, 2, 3]);
      expect(state.executions.map((e: any) => e.retryAttempt)).toEqual([
        0, 1, 2,
      ]);
      expect(sessions).toEqual([
        null,
        "safe-fixture-session",
        "safe-fixture-session",
      ]);
      expect(
        await dbCount(f.path, "SELECT COUNT(*) AS n FROM schedule_firings"),
      ).toBe(2);
    } finally {
      await f.close();
    }
  });
});

describe("receipt metadata compatibility", () => {
  it("preserves unknown metadata and historical receipts through many executions and restart", async () => {
    const f = setup("empty");
    try {
      const created = (
        await post(f.hub, "/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json();
      const db = new DatabaseSync(f.path);
      try {
        const row = db
          .prepare("SELECT metadata FROM work_items WHERE id=?")
          .get(created.workItem.id)!;
        const metadata = JSON.parse(String(row.metadata));
        metadata.futureField = { source: "fixture", nested: [1, 2, 3] };
        db.prepare("UPDATE work_items SET metadata=? WHERE id=?").run(
          JSON.stringify(metadata),
          created.workItem.id,
        );
      } finally {
        db.close();
      }
      const times: number[] = [];
      let first:
        { id: string; digest: string; executionId: string } | undefined;
      for (let i = 0; i < 200; i++) {
        const begin = performance.now();
        const c = (
          await post(f.hub, "/api/executions/claim", { workerId: "perf" })
        ).json();
        const submissionId = randomUUID();
        const digest = resultDigest(ask);
        const body = {
          workerId: "perf",
          leaseToken: c.leaseToken,
          submissionId,
          resultDigest: digest,
          result: ask,
        };
        const response = await post(
          f.hub,
          `/api/executions/${c.execution.id}/result`,
          body,
        );
        expect(response.statusCode).toBe(200);
        if (!first)
          first = { id: submissionId, digest, executionId: c.execution.id };
        const details = await item(f.hub, created.workItem.id);
        const interaction = details.interactions.at(-1);
        expect(
          (
            await post(f.hub, `/api/interactions/${interaction.id}/answer`, {
              answer: "yes",
            })
          ).statusCode,
        ).toBe(200);
        times.push(performance.now() - begin);
      }
      const last = (
        await post(f.hub, "/api/executions/claim", { workerId: "perf" })
      ).json();
      const done = {
        type: "completed",
        sessionId: "perf-session",
        output: "done",
      };
      const sid = randomUUID();
      const dg = resultDigest(done);
      const body = {
        workerId: "perf",
        leaseToken: last.leaseToken,
        submissionId: sid,
        resultDigest: dg,
        result: done,
      };
      expect(
        (await post(f.hub, `/api/executions/${last.execution.id}/result`, body))
          .statusCode,
      ).toBe(200);
      const replay = await post(
        f.hub,
        `/api/executions/${last.execution.id}/result`,
        body,
      );
      expect(replay.json().status).toBe("already_committed");
      await f.restart();
      const state = await item(f.hub, created.workItem.id);
      const metadata = state.workItem.metadata;
      expect(metadata.futureField).toEqual({
        source: "fixture",
        nested: [1, 2, 3],
      });
      expect(metadata.eventId).toBeTruthy();
      expect(Object.keys(metadata.taskcircuitResultReceiptsV1)).toHaveLength(
        201,
      );
      expect(state.executions).toHaveLength(201);
      expect(state.interactions).toHaveLength(200);
      expect(state.agentSession.externalSessionId).toBe("perf-session");
      expect(JSON.stringify(state)).not.toContain(last.leaseToken);
      const confirm = await f.hub.inject(
        `/api/executions/${first!.executionId}/result-submissions/${first!.id}?digest=${first!.digest}`,
      );
      expect(confirm.json().status).toBe("committed");
      const avg = (values: number[]) =>
        values.reduce((sum, value) => sum + value, 0) / values.length;
      console.log(
        "RECEIPT_METRICS",
        JSON.stringify({
          executions: 201,
          metadataBytes: Buffer.byteLength(JSON.stringify(metadata)),
          first50MeanMs: Number(avg(times.slice(0, 50)).toFixed(3)),
          last50MeanMs: Number(avg(times.slice(-50)).toFixed(3)),
        }),
      );
    } finally {
      await f.close();
    }
  }, 30000);
});
