// Guards scheduler atomicity and detects whether one corrupt firing starves unrelated schedules.
import { describe, expect, it } from "vitest";
import { fork, spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";

const baseTime = Date.parse("2026-11-08T00:00:00Z");
const post = (
  hub: ReturnType<typeof createHub>,
  url: string,
  payload: unknown = {},
) => hub.inject({ method: "POST", url, payload });
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
async function until(check: () => boolean) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw new Error("fixture timeout");
    await pause();
  }
}
function open() {
  const dir = mkdtempSync(join(tmpdir(), "tc-scheduler-investigation-"));
  const path = join(dir, "db");
  let now = baseTime;
  let hub = createHub(path, defaultConfig, () => now, 0, {
    dispatcherPollMs: 0,
  });
  return {
    dir,
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
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function create(hub: ReturnType<typeof createHub>, due: number) {
  const response = await post(hub, "/api/schedules", {
    kind: "once",
    runAt: new Date(due).toISOString(),
    event: { source: "local", type: "demo.cron", payload: {} },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
function rows(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      firings: Number(
        db.prepare("SELECT COUNT(*) AS n FROM schedule_firings").get()!.n,
      ),
      work: Number(db.prepare("SELECT COUNT(*) AS n FROM work_items").get()!.n),
      executions: Number(
        db.prepare("SELECT COUNT(*) AS n FROM executions").get()!.n,
      ),
    };
  } finally {
    db.close();
  }
}
describe("scheduler firing investigation", () => {
  it("A and C: repeated ticks and reopening after commit do not repeat a firing", async () => {
    const f = open();
    try {
      const schedule = await create(f.hub, f.time() + 1000);
      f.advance(1000);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(f.hub.tickScheduler()).toBe(0);
      await f.restart();
      expect(f.hub.tickScheduler()).toBe(0);
      expect(rows(f.path)).toEqual({ firings: 1, work: 1, executions: 1 });
      expect(
        (await f.hub.inject(`/api/schedules/${schedule.id}`)).json().status,
      ).toBe("completed");
    } finally {
      await f.close();
    }
  });
  it("B: independent competing processes commit only one firing, Work Item and Execution", async () => {
    const f = open();
    const children: ReturnType<typeof fork>[] = [];
    try {
      await create(f.hub, f.time() + 1000);
      f.advance(1000);
      for (let i = 0; i < 2; i++)
        children.push(
          fork(
            join(process.cwd(), "tests/fixtures/scheduler-race.mjs"),
            [f.path, String(f.time())],
            { stdio: ["ignore", "ignore", "ignore", "ipc"] },
          ),
        );
      await Promise.all(
        children.map(
          (c) =>
            new Promise<void>((resolve, reject) => {
              c.once("message", (m) =>
                m === "ready" ? resolve() : reject(Error("unexpected ready")),
              );
              c.once("error", reject);
            }),
        ),
      );
      const results = children.map(
        (c) =>
          new Promise<{ count?: number; error?: string }>((resolve, reject) => {
            let result: { count?: number; error?: string } | undefined;
            c.once("message", (m) => {
              result = m as typeof result;
            });
            c.once("exit", (code) =>
              code === 0 && result
                ? resolve(result)
                : reject(Error(`child exit ${code}`)),
            );
            c.once("error", reject);
          }),
      );
      children.forEach((c) => c.send("go"));
      const values = await Promise.all(results);
      expect(values.map((x) => x.error)).toEqual([undefined, undefined]);
      expect(values.map((x) => x.count).sort()).toEqual([0, 1]);
      expect(rows(f.path)).toEqual({ firings: 1, work: 1, executions: 1 });
    } finally {
      children.forEach((c) => {
        if (c.exitCode === null) c.kill();
      });
      await f.close();
    }
  }, 15000);
  it("D: killing after insert before schedule update rolls back and permits one later firing", async () => {
    const f = open();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const schedule = await create(f.hub, f.time() + 1000);
      f.advance(1000);
      const marker = join(f.dir, "inserted");
      child = spawn(
        process.execPath,
        [
          join(process.cwd(), "tests/fixtures/scheduler-kill-after-firing.mjs"),
          f.path,
          String(f.time()),
          marker,
        ],
        { stdio: "ignore", windowsHide: true },
      );
      await until(() => existsSync(marker));
      const stopped = new Promise<void>((resolve, reject) => {
        child!.once("exit", () => resolve());
        child!.once("error", reject);
      });
      child.kill("SIGKILL");
      await stopped;
      await f.restart();
      expect(rows(f.path)).toEqual({ firings: 0, work: 0, executions: 0 });
      const after = (
        await f.hub.inject(`/api/schedules/${schedule.id}`)
      ).json();
      expect(after.status).toBe("active");
      expect(after.nextFireAt).toBe(new Date(f.time()).toISOString());
      expect(f.hub.tickScheduler()).toBe(1);
      expect(f.hub.tickScheduler()).toBe(0);
      expect(rows(f.path)).toEqual({ firings: 1, work: 1, executions: 1 });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill();
      await f.close();
    }
  }, 15000);
  it("E: a duplicate active firing does not block a distinct later due schedule", async () => {
    const f = open();
    try {
      const corrupt = await create(f.hub, f.time() + 1000);
      const normal = await create(f.hub, f.time() + 2000);
      f.advance(1000);
      expect(f.hub.tickScheduler()).toBe(1);
      const db = new DatabaseSync(f.path);
      try {
        db.prepare(
          "UPDATE schedules SET status='active',next_fire_at=? WHERE id=?",
        ).run(new Date(f.time()).toISOString(), corrupt.id);
      } finally {
        db.close();
      }
      f.advance(1000);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(f.hub.tickScheduler()).toBe(0);
      expect(
        (await f.hub.inject(`/api/schedules/${normal.id}`)).json().status,
      ).toBe("completed");
      expect(rows(f.path)).toEqual({ firings: 2, work: 2, executions: 2 });
    } finally {
      await f.close();
    }
  });
  it("F: public pause, resume, fire and cancel cannot reactivate a completed once schedule", async () => {
    const f = open();
    try {
      const schedule = await create(f.hub, f.time() + 1000);
      expect(
        (await post(f.hub, `/api/schedules/${schedule.id}/pause`)).statusCode,
      ).toBe(200);
      f.advance(1000);
      expect(f.hub.tickScheduler()).toBe(0);
      expect(
        (await post(f.hub, `/api/schedules/${schedule.id}/resume`)).statusCode,
      ).toBe(200);
      expect(f.hub.tickScheduler()).toBe(1);
      expect(
        (await post(f.hub, `/api/schedules/${schedule.id}/pause`)).statusCode,
      ).toBe(409);
      expect(
        (await post(f.hub, `/api/schedules/${schedule.id}/resume`)).statusCode,
      ).toBe(409);
      expect(
        (
          await f.hub.inject({
            method: "DELETE",
            url: `/api/schedules/${schedule.id}`,
          })
        ).statusCode,
      ).toBe(409);
      const other = await create(f.hub, f.time() + 1000);
      expect(
        (
          await f.hub.inject({
            method: "DELETE",
            url: `/api/schedules/${other.id}`,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await post(f.hub, `/api/schedules/${other.id}/resume`)).statusCode,
      ).toBe(409);
      f.advance(1000);
      expect(f.hub.tickScheduler()).toBe(0);
      expect(rows(f.path)).toEqual({ firings: 1, work: 1, executions: 1 });
    } finally {
      await f.close();
    }
  });
  it("F clock rollback: public Cron creation must not repeat its committed scheduled time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-clock-rollback-"));
    const path = join(dir, "db");
    let now = baseTime;
    let clockCalls = 0;
    let injectRollback = false;
    const hub = createHub(
      path,
      defaultConfig,
      () => {
        if (injectRollback && ++clockCalls === 4) now = baseTime;
        return now;
      },
      0,
      { dispatcherPollMs: 0 },
    );
    try {
      const created = await post(hub, "/api/schedules", {
        kind: "cron",
        expression: "* * * * *",
        timezone: "UTC",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      expect(created.statusCode).toBe(200);
      const cron = created.json();
      const normal = await create(hub, baseTime + 61000);
      now += 60000;
      injectRollback = true;
      expect(hub.tickScheduler()).toBe(1);
      injectRollback = false;
      const state = (await hub.inject(`/api/schedules/${cron.id}`)).json();
      expect(state.status).toBe("active");
      expect(state.lastFireAt).toBe(new Date(baseTime + 60000).toISOString());
      expect(state.nextFireAt).toBe(new Date(baseTime + 120000).toISOString());
      expect(clockCalls).toBe(1);
      expect(rows(path)).toEqual({ firings: 1, work: 1, executions: 1 });
      now = baseTime + 61000;
      let error: unknown;
      try {
        hub.tickScheduler();
      } catch (e) {
        error = e;
      }
      expect(
        (await hub.inject(`/api/schedules/${normal.id}`)).json().status,
      ).toBe("completed");
      expect(error).toBeUndefined();
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
