// Guards transient heartbeat errors and a commit racing with a stale heartbeat response.
import { describe, expect, it } from "vitest";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
import type { AgentAdapter } from "../src/adapter.js";
const timing = { heartbeatMs: 20, safetyMs: 500, requestTimeoutMs: 100 };
const post = (h: ReturnType<typeof createHub>, url: string, payload: unknown) =>
  h.inject({ method: "POST", url, payload });
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(f: () => boolean) {
  const end = Date.now() + 3000;
  while (!f()) {
    if (Date.now() > end) throw new Error("fixture timed out");
    await pause();
  }
}
describe("heartbeat recovery and result race", () => {
  it("treats HTTP 500 as temporary and resumes after renewal", async () => {
    const hub = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const original = globalThis.fetch;
    let heartbeat = 0,
      started = false,
      aborted = false;
    let finish!: () => void;
    const adapter: AgentAdapter = {
      execute(_input, signal) {
        started = true;
        return new Promise((resolve, reject) => {
          finish = () =>
            resolve({ type: "completed", sessionId: "fake", output: "ok" });
          signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    };
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      await post(hub, "/api/events", {
        source: "local",
        type: "demo.retry",
        payload: {},
      });
      globalThis.fetch = async (...args) => {
        if (String(args[0]).includes("/heartbeat") && ++heartbeat <= 2)
          return new Response("", { status: 500 });
        return original(...args);
      };
      const work = workOnce(base, "w", adapter, undefined, timing);
      await until(() => started && heartbeat >= 3);
      finish();
      expect(await work).toBe(true);
      expect(aborted).toBe(false);
    } finally {
      globalThis.fetch = original;
      await hub.close();
    }
  });
  it("confirms a committed result after the response is lost and heartbeat returns 409", async () => {
    const hub = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const original = globalThis.fetch;
    let calls = 0,
      committed = false,
      heartbeat409 = false;
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      const item = (
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
        if (path.endsWith("/result")) {
          const response = await original(...args);
          expect(response.status).toBe(200);
          committed = true;
          await until(() => heartbeat409);
          throw new Error("response lost after commit");
        }
        const response = await original(...args);
        if (committed && path.includes("/heartbeat") && response.status === 409)
          heartbeat409 = true;
        return response;
      };
      expect(await workOnce(base, "w", adapter, undefined, timing)).toBe(true);
      const state = (
        await hub.inject(`/api/work-items/${item.workItem.id}`)
      ).json();
      expect(heartbeat409).toBe(true);
      expect(calls).toBe(1);
      expect(state.workItem.status).toBe("completed");
      expect(state.executions).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
      await hub.close();
    }
  });
});
