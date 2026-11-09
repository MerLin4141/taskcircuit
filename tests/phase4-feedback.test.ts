// Guards compatibility and rejects malformed autonomous Agent feedback.
import { it, expect } from "vitest";
import { parseResponse } from "../src/agents/protocol.js";
it("accepts Continue and Stop without weakening existing response validation", () => {
  expect(
    parseResponse(JSON.stringify({ kind: "continue", message: "next" })),
  ).toEqual({ kind: "continue", message: "next" });
  expect(
    parseResponse(JSON.stringify({ kind: "stop", message: "done" })),
  ).toEqual({ kind: "stop", message: "done" });
  expect(() =>
    parseResponse(JSON.stringify({ kind: "continue", message: "" })),
  ).toThrow();
  expect(() =>
    parseResponse(
      JSON.stringify({
        kind: "stop",
        message: "done",
        capabilities: ["shell"],
      }),
    ),
  ).toThrow();
});

import { createHub } from "./fixtures/g2-hub.js";
import { defaultConfig } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resultDigest } from "../src/result-receipt.js";
it.each(["continue", "stop"])(
  "commits %s idempotently without another Agent run",
  async (type) => {
    const dir = mkdtempSync(join(tmpdir(), "tc-fb-"));
    const hub = createHub(join(dir, "db"), defaultConfig, () => 0, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const create = await hub.inject({
        method: "POST",
        url: "/api/events",
        payload: { source: "local", type: "demo.color", payload: {} },
      });
      const item = create.json().workItem;
      const claim = (
        await hub.inject({
          method: "POST",
          url: "/api/executions/claim",
          payload: { workerId: "w" },
        })
      ).json();
      const result = { type, sessionId: "fake-session", message: "done" };
      const payload = {
        workerId: "w",
        leaseToken: claim.leaseToken,
        submissionId: randomUUID(),
        resultDigest: resultDigest(result),
        result,
      };
      const url = `/api/executions/${claim.execution.id}/result`;
      expect(
        (await hub.inject({ method: "POST", url, payload })).json().status,
      ).toBe("accepted");
      expect(
        (await hub.inject({ method: "POST", url, payload })).json().status,
      ).toBe("already_committed");
      expect(
        (
          await hub.inject({
            method: "POST",
            url,
            payload: { ...payload, result: { ...result, message: "changed" } },
          })
        ).statusCode,
      ).toBe(409);
      const details = (
        await hub.inject({ method: "GET", url: `/api/work-items/${item.id}` })
      ).json();
      expect(details.executions).toHaveLength(1);
      expect(details.workItem.status).toBe(
        type === "continue" ? "waiting_schedule" : "cancelled",
      );
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

import { workOnce } from "../src/worker.js";
it.each([
  { type: "completed", sessionId: "s", output: "done" },
  { type: "continue", sessionId: "s", message: "next" },
  { type: "stop", sessionId: "s", message: "stop" },
  {
    type: "needs_input",
    sessionId: "s",
    request: { title: "q", text: "q", key: "q", options: ["yes"] },
  },
  { type: "later", sessionId: "s", message: "later", afterSeconds: 2 },
] as const)(
  "reconciles lost response for $type without rerunning Agent",
  async (result) => {
    const dir = mkdtempSync(join(tmpdir(), "tc-fb-loss-"));
    const hub = createHub(join(dir, "db"), defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const original = globalThis.fetch;
    let calls = 0,
      posts = 0,
      queries = 0;
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      const created = (
        await hub.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.color", payload: {} },
        })
      ).json();
      globalThis.fetch = async (...args) => {
        const url = String(args[0]);
        if (url.includes("/result-submissions/")) queries++;
        if (url.endsWith("/result") && ++posts === 1) {
          await original(...args);
          throw Error("lost response");
        }
        return original(...args);
      };
      expect(
        await workOnce(base, "w", {
          async execute() {
            calls++;
            return result;
          },
        }),
      ).toBe(true);
      expect(calls).toBe(1);
      expect(queries).toBeGreaterThan(0);
      const detail = (
        await hub.inject(`/api/work-items/${created.workItem.id}`)
      ).json();
      expect(detail.executions).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
