// Guards cancellation, transient heartbeat recovery, uncertain leases, and Agent process-tree cleanup.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
import { ProcessRunner } from "../src/agents/process.js";
import { DatabaseSync } from "node:sqlite";
import { classifyStartFailure } from "../src/agents/errors.js";
import { formatWorkItem } from "../src/cli-format.js";
import type { AgentAdapter } from "../src/adapter.js";

const timing = { heartbeatMs: 20, safetyMs: 180, requestTimeoutMs: 60 };
const post = (
  hub: ReturnType<typeof createHub>,
  url: string,
  payload: unknown,
) => hub.inject({ method: "POST", url, payload });
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(condition: () => boolean, limit = 2000) {
  const end = Date.now() + limit;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("fixture timed out");
    await tick();
  }
}
function blockedAgent() {
  let started = false;
  let aborted = false;
  let complete!: () => void;
  const adapter: AgentAdapter = {
    execute(_input, signal) {
      started = true;
      return new Promise((resolve, reject) => {
        complete = () =>
          resolve({ type: "completed", sessionId: "fake", output: "done" });
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("stopped"));
          },
          { once: true },
        );
      });
    },
  };
  return {
    adapter,
    isStarted: () => started,
    isAborted: () => aborted,
    finish: () => complete(),
  };
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tc-cancel-"));
  let now = Date.parse("2026-01-01T00:00:00Z");
  let hub = createHub(join(dir, "db"), defaultConfig, () => now, 0, {
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
  return {
    dir,
    hub,
    base,
    created,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    async close() {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("uncertain execution cancellation", () => {
  it("classifies only known transient OS start failures as retryable", () => {
    expect(classifyStartFailure({ code: "EAGAIN" })).toMatchObject({
      code: "agent_execution",
      retryable: true,
      safeToRetry: true,
    });
    expect(classifyStartFailure({ code: "ENOENT" })).toMatchObject({
      code: "agent_unavailable",
      retryable: false,
    });
  });
  it("explains the uncertain result in human output without dropping its JSON code", async () => {
    const f = await fixture();
    try {
      const claim = (
        await post(f.hub, "/api/executions/claim", { workerId: "old" })
      ).json();
      f.advance(31000);
      expect(
        (await post(f.hub, "/api/executions/claim", { workerId: "other" }))
          .statusCode,
      ).toBe(204);
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.executions[0].id).toBe(claim.execution.id);
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
      const text = formatWorkItem(state);
      expect(text).toContain("执行结果需要核实");
      expect(text).toContain("可能已经执行了外部操作");
      expect(text).toContain("不会自动重新执行");
      expect(text).toContain("核实外部结果");
    } finally {
      await f.close();
    }
  });
  it("aborts the current Agent after a user cancels the Work Item", async () => {
    const f = await fixture();
    const a = blockedAgent();
    try {
      const work = workOnce(
        f.base,
        "worker",
        a.adapter,
        undefined,
        timing,
      ).catch((e: Error) => e);
      await until(a.isStarted);
      expect(
        (
          await post(
            f.hub,
            `/api/work-items/${f.created.workItem.id}/cancel`,
            {},
          )
        ).statusCode,
      ).toBe(200);
      await work;
      expect(a.isAborted()).toBe(true);
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.workItem.status).toBe("cancelled");
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
    } finally {
      await f.close();
    }
  });
  it("aborts the current Agent on Worker shutdown and records uncertainty", async () => {
    const f = await fixture();
    const a = blockedAgent();
    const shutdown = new AbortController();
    try {
      const work = workOnce(
        f.base,
        "worker",
        a.adapter,
        shutdown.signal,
        timing,
      );
      await until(a.isStarted);
      shutdown.abort();
      await work;
      expect(a.isAborted()).toBe(true);
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
      expect(state.schedules).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("continues after one transient heartbeat failure and a successful renewal", async () => {
    const f = await fixture();
    const a = blockedAgent();
    const original = globalThis.fetch;
    let failures = 0;
    let renewed = false;
    globalThis.fetch = async (...args) => {
      if (String(args[0]).includes("/heartbeat")) {
        if (!failures++) throw new Error("temporary offline");
        const response = await original(...args);
        renewed = response.ok;
        return response;
      }
      return original(...args);
    };
    try {
      const work = workOnce(f.base, "worker", a.adapter, undefined, timing);
      await until(a.isStarted);
      await until(() => renewed);
      a.finish();
      expect(await work).toBe(true);
      expect(a.isAborted()).toBe(false);
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.workItem.status).toBe("completed");
    } finally {
      globalThis.fetch = original;
      await f.close();
    }
  });
  it("aborts after the safe lease deadline when heartbeat remains unreachable", async () => {
    const f = await fixture();
    const a = blockedAgent();
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      if (String(args[0]).includes("/heartbeat")) throw new Error("offline");
      return original(...args);
    };
    try {
      await workOnce(f.base, "worker", a.adapter, undefined, timing).catch(
        () => {},
      );
      expect(a.isAborted()).toBe(true);
      f.advance(31000);
      expect(
        (await post(f.hub, "/api/executions/claim", { workerId: "other" }))
          .statusCode,
      ).toBe(204);
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
    } finally {
      globalThis.fetch = original;
      await f.close();
    }
  });
  it("does not treat a completion racing with shutdown as a successful result", async () => {
    const f = await fixture();
    const a = blockedAgent();
    const shutdown = new AbortController();
    try {
      const work = workOnce(
        f.base,
        "worker",
        a.adapter,
        shutdown.signal,
        timing,
      );
      await until(a.isStarted);
      a.finish();
      shutdown.abort();
      await work;
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
    } finally {
      await f.close();
    }
  });
  it("stops a legacy retry that has no proof the Agent did not start", async () => {
    const f = await fixture();
    let reopened: ReturnType<typeof createHub> | undefined;
    try {
      const claim = (
        await post(f.hub, "/api/executions/claim", { workerId: "old" })
      ).json();
      expect(
        (
          await post(f.hub, `/api/executions/${claim.execution.id}/result`, {
            workerId: "old",
            leaseToken: claim.leaseToken,
            result: {
              type: "failed",
              error: {
                code: "agent_execution",
                message: "old",
                retryable: true,
                safeToRetry: true,
              },
            },
          })
        ).statusCode,
      ).toBe(200);
      await f.hub.close();
      const db = new DatabaseSync(join(f.dir, "db"));
      db.prepare("UPDATE executions SET error=? WHERE id=?").run(
        JSON.stringify({
          code: "agent_timeout",
          message: "legacy",
          retryable: true,
        }),
        claim.execution.id,
      );
      db.close();
      f.advance(3000);
      reopened = createHub(join(f.dir, "db"), defaultConfig, f.now, 0, {
        dispatcherPollMs: 0,
      });
      expect(reopened.tickScheduler()).toBe(1);
      const state = (
        await reopened.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.executions).toHaveLength(1);
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
      expect(state.schedules[0].status).toBe("cancelled");
      expect(state.workItem.status).toBe("failed");
    } finally {
      if (reopened) await reopened.close();
      else await f.hub.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("marks an expired execution unknown without waiting for another Worker", async () => {
    const f = await fixture();
    try {
      await post(f.hub, "/api/executions/claim", { workerId: "old" });
      f.advance(31000);
      f.hub.tickScheduler();
      const state = (
        await f.hub.inject(`/api/work-items/${f.created.workItem.id}`)
      ).json();
      expect(state.workItem.status).toBe("failed");
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
      expect(state.schedules).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("rejects an expired result and persists unknown after Hub restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-restart-"));
    let now = Date.parse("2026-01-01T00:00:00Z");
    let hub = createHub(join(dir, "db"), defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const item = (
        await post(hub, "/api/events", {
          source: "local",
          type: "demo.retry",
          payload: {},
        })
      ).json();
      const claim = (
        await post(hub, "/api/executions/claim", { workerId: "old" })
      ).json();
      now += 31000;
      const [result, next] = await Promise.all([
        post(hub, `/api/executions/${claim.execution.id}/result`, {
          workerId: "old",
          leaseToken: claim.leaseToken,
          result: { type: "completed", sessionId: "fake", output: "done" },
        }),
        post(hub, "/api/executions/claim", { workerId: "new" }),
      ]);
      expect(result.statusCode).toBe(409);
      expect(next.statusCode).toBe(204);
      await hub.close();
      hub = createHub(join(dir, "db"), defaultConfig, () => now, 0, {
        dispatcherPollMs: 0,
      });
      expect(
        (await post(hub, "/api/executions/claim", { workerId: "new" }))
          .statusCode,
      ).toBe(204);
      const state = (
        await hub.inject(`/api/work-items/${item.workItem.id}`)
      ).json();
      expect(state.executions[0].error.code).toBe("execution_outcome_unknown");
      expect(state.schedules).toHaveLength(0);
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("settles once when process completion races its timeout", async () => {
    const runner = new ProcessRunner();
    const result = await runner
      .run({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 100)"],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 100,
      })
      .then(
        (value) => ({ kind: "completed", value }),
        (error: unknown) => ({ kind: "error", error }),
      );
    if (result.kind === "completed") expect(result.value?.exitCode).toBe(0);
    else
      expect(result.error).toMatchObject({
        code: "agent_timeout",
        retryable: false,
      });
  });
  it("terminates a process and its child on cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-tree-"));
    const path = join(dir, "pids");
    const controller = new AbortController();
    const script = `const {spawn}=require("node:child_process");const fs=require("node:fs");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`;
    const running = new ProcessRunner()
      .run({
        executable: process.execPath,
        args: ["-e", script, path],
        cwd: dir,
        env: process.env,
        timeoutMs: 5000,
        signal: controller.signal,
      })
      .catch((e: Error) => e);
    let pids: number[] = [];
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await until(() => existsSync(path));
      pids = JSON.parse(readFileSync(path, "utf8"));
      expect(pids.every(alive)).toBe(true);
      controller.abort();
      await running;
      await until(() => pids.every((pid) => !alive(pid)));
      expect(pids.every((pid) => !alive(pid))).toBe(true);
    } finally {
      for (const pid of pids)
        if (alive(pid)) {
          try {
            process.kill(pid);
          } catch {}
        }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10000);
});
