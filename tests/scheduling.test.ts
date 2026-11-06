// Guards durable scheduling against lost or duplicated firings, retries, and broken session lineage.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { DatabaseSync } from "node:sqlite";
import { fork } from "node:child_process";
import { workOnce } from "../src/worker.js";
import { MockAgentAdapter } from "../src/adapter.js";
import { retryDelay } from "../src/scheduling.js";
import { parseResponse } from "../src/agents/protocol.js";
const post = (
  hub: ReturnType<typeof createHub>,
  url: string,
  payload: unknown,
) => hub.inject({ method: "POST", url, payload });
const create = (hub: ReturnType<typeof createHub>, type = "demo.retry") =>
  post(hub, "/api/events", { source: "local", type, payload: {} });
const claim = (hub: ReturnType<typeof createHub>) =>
  post(hub, "/api/executions/claim", { workerId: "test" });
const result = (hub: ReturnType<typeof createHub>, c: any, r: unknown) =>
  post(hub, `/api/executions/${c.execution.id}/result`, {
    workerId: "test",
    leaseToken: c.leaseToken,
    result: r,
  });
const detail = (hub: ReturnType<typeof createHub>, id: string) =>
  hub.inject(`/api/work-items/${id}`).then((r) => r.json());
const failed = {
  type: "failed",
  error: { code: "agent_execution", message: "transient", retryable: true },
};
describe("durable schedules", () => {
  it("enforces later payload exclusivity", () => {
    expect(
      parseResponse('{"kind":"later","message":"wait","afterSeconds":2}').kind,
    ).toBe("later");
    for (const s of [
      '{"kind":"later","message":"x"}',
      '{"kind":"later","message":"x","afterSeconds":2,"runAt":"2026-11-08T00:00:00Z"}',
    ])
      expect(() => parseResponse(s)).toThrow();
  });
  it("persists later across restart and resumes the same session once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-sched-"));
    const path = join(dir, "db");
    let time = Date.parse("2026-11-08T00:00:00Z");
    let hub = createHub(path, defaultConfig, () => time);
    try {
      const created = (await create(hub, "demo.later")).json();
      const c = (await claim(hub)).json();
      expect(
        (
          await result(hub, c, {
            type: "later",
            sessionId: "external",
            message: "稍后继续",
            afterSeconds: 2,
          })
        ).statusCode,
      ).toBe(200);
      let d = await detail(hub, created.workItem.id);
      expect(d.workItem.status).toBe("waiting_schedule");
      expect(d.executions[0].status).toBe("completed");
      const sid = d.agentSession.id;
      await hub.close();
      time += 3000;
      hub = createHub(path, defaultConfig, () => time);
      expect(hub.tickScheduler()).toBe(1);
      expect(hub.tickScheduler()).toBe(0);
      const next = (await claim(hub)).json();
      expect(next.execution.id).not.toBe(c.execution.id);
      expect(next.execution.agentSessionId).toBe(sid);
      expect(next.agentSession.externalSessionId).toBe("external");
      expect(next.execution.triggerKind).toBe("scheduled_resume");
      expect(
        (
          await result(hub, next, {
            type: "completed",
            sessionId: "external",
            output: "done",
          })
        ).statusCode,
      ).toBe(200);
      d = await detail(hub, created.workItem.id);
      expect(d.workItem.status).toBe("completed");
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("retries with fixed delay, records lineage and stops at max attempts", async () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const hub = createHub(":memory:", defaultConfig, () => t);
    try {
      const item = (await create(hub, "demo.retry.exhaust")).json().workItem;
      for (let n = 0; n < 3; n++) {
        const c = (await claim(hub)).json();
        expect(c.execution.retryAttempt).toBe(n);
        expect((await result(hub, c, failed)).statusCode).toBe(200);
        const d = await detail(hub, item.id);
        if (n < 2) {
          expect(d.workItem.status).toBe("waiting_schedule");
          expect(hub.tickScheduler()).toBe(0);
          t += 2000;
          expect(hub.tickScheduler()).toBe(1);
        } else expect(d.workItem.status).toBe("failed");
      }
      expect((await claim(hub)).statusCode).toBe(204);
      expect(
        (await hub.inject("/api/schedules"))
          .json()
          .filter((s: any) => s.status === "active"),
      ).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });
  it("does not retry a non-retryable failure", async () => {
    const hub = createHub(":memory:", defaultConfig);
    try {
      const w = (await create(hub)).json().workItem;
      const c = (await claim(hub)).json();
      await result(hub, c, {
        type: "failed",
        error: { code: "agent_protocol", message: "bad", retryable: false },
      });
      expect((await detail(hub, w.id)).workItem.status).toBe("failed");
      expect((await hub.inject("/api/schedules")).json()).toHaveLength(0);
    } finally {
      await hub.close();
    }
  });
  it("cron fire-once deduplicates across hubs and respects timezone after downtime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-cron-"));
    const path = join(dir, "db");
    let t = Date.parse("2026-11-08T00:00:00Z");
    let a = createHub(path, defaultConfig, () => t);
    let b: ReturnType<typeof createHub> | undefined;
    try {
      const r = await post(a, "/api/schedules", {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "Asia/Shanghai",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      expect(r.statusCode).toBe(200);
      const schedule = r.json();
      expect(schedule.nextFireAt).toBe("2026-11-08T01:00:00.000Z");
      await a.close();
      t += 3 * 86400000;
      b = createHub(path, defaultConfig, () => t);
      a = createHub(path, defaultConfig, () => t);
      expect(a.tickScheduler() + b.tickScheduler()).toBe(1);
      const updated = (await a.inject(`/api/schedules/${schedule.id}`)).json();
      expect(updated.nextFireAt > "2026-11-11T00:00:00.000Z").toBe(true);
      expect((await a.inject("/api/work-items")).json()).toHaveLength(1);
    } finally {
      await a.close();
      if (b) await b.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("pauses, resumes and cancels a once schedule", async () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const hub = createHub(":memory:", defaultConfig, () => t);
    try {
      const s = (
        await post(hub, "/api/schedules", {
          kind: "once",
          runAt: "2026-11-08T00:00:01.000Z",
          event: { source: "local", type: "demo.cron", payload: {} },
        })
      ).json();
      expect(
        (await post(hub, `/api/schedules/${s.id}/pause`, {})).statusCode,
      ).toBe(200);
      t += 2000;
      expect(hub.tickScheduler()).toBe(0);
      await post(hub, `/api/schedules/${s.id}/resume`, {});
      expect(hub.tickScheduler()).toBe(1);
      const s2 = (
        await post(hub, "/api/schedules", {
          kind: "once",
          runAt: "2026-11-08T00:00:03.000Z",
          event: { source: "local", type: "demo.cron", payload: {} },
        })
      ).json();
      expect(
        (await hub.inject({ method: "DELETE", url: `/api/schedules/${s2.id}` }))
          .statusCode,
      ).toBe(200);
      t += 3000;
      expect(hub.tickScheduler()).toBe(0);
    } finally {
      await hub.close();
    }
  });
  it("preserves answers and session when a resumed execution is retried", async () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const config = {
      ...defaultConfig,
      routes: defaultConfig.routes.map((r) =>
        r.id === "demo-color"
          ? {
              ...r,
              retryPolicy: {
                maxAttempts: 3,
                strategy: "fixed" as const,
                initialDelaySeconds: 2,
                maxDelaySeconds: 2,
              },
            }
          : r,
      ),
    };
    const hub = createHub(":memory:", config, () => t, 0);
    try {
      const w = (await create(hub, "demo.color")).json().workItem;
      const a = (await claim(hub)).json();
      await result(hub, a, {
        type: "needs_input",
        sessionId: "session",
        request: {
          title: "颜色",
          text: "请选择",
          key: "color",
          options: ["蓝色"],
        },
      });
      let d = await detail(hub, w.id);
      await post(hub, `/api/interactions/${d.interactions[0].id}/answer`, {
        answer: "蓝色",
      });
      const b = (await claim(hub)).json();
      expect(b.execution.triggerKind).toBe("human_answer");
      await result(hub, b, failed);
      t += 2000;
      hub.tickScheduler();
      const c = (await claim(hub)).json();
      expect(c.execution.retryAttempt).toBe(1);
      expect(c.execution.parentExecutionId).toBe(b.execution.id);
      expect(c.previousInteractions[0].response).toBe("蓝色");
      expect(c.agentSession.externalSessionId).toBe("session");
    } finally {
      await hub.close();
    }
  });
  it("cancels work-owned schedules without cancelling independent cron schedules", async () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const hub = createHub(":memory:", defaultConfig, () => t, 0);
    try {
      const w = (await create(hub, "demo.later")).json().workItem;
      const c = (await claim(hub)).json();
      await result(hub, c, {
        type: "later",
        sessionId: "s",
        message: "wait",
        afterSeconds: 2,
      });
      const cron = (
        await post(hub, "/api/schedules", {
          kind: "cron",
          expression: "* * * * *",
          event: { source: "local", type: "demo.cron", payload: {} },
        })
      ).json();
      expect(
        (await post(hub, `/api/work-items/${w.id}/cancel`, {})).statusCode,
      ).toBe(200);
      t += 3000;
      expect(hub.tickScheduler()).toBe(0);
      expect(
        (await hub.inject(`/api/schedules/${cron.id}`)).json().status,
      ).toBe("active");
      expect((await detail(hub, w.id)).schedules[0].status).toBe("cancelled");
    } finally {
      await hub.close();
    }
  });
  it("calculates bounded fixed and exponential delays", () => {
    expect(
      retryDelay(
        {
          maxAttempts: 3,
          strategy: "fixed",
          initialDelaySeconds: 5,
          maxDelaySeconds: 20,
        },
        3,
      ),
    ).toBe(5);
    expect(
      [1, 2, 3, 99].map((n) =>
        retryDelay(
          {
            maxAttempts: 4,
            strategy: "exponential",
            initialDelaySeconds: 5,
            maxDelaySeconds: 20,
          },
          n,
        ),
      ),
    ).toEqual([5, 10, 20, 20]);
  });
  it("retains phase 2 records when applying the second migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-upgrade-"));
    const path = join(dir, "db");
    let h = createHub(path, defaultConfig, undefined, 0);
    try {
      const w = (await create(h, "demo.color")).json().workItem;
      const c = (await claim(h)).json();
      await result(h, c, {
        type: "needs_input",
        sessionId: "old-session",
        request: {
          title: "颜色",
          text: "请选择",
          key: "color",
          options: ["蓝色"],
        },
      });
      await h.close();
      const db = new DatabaseSync(path);
      db.exec(
        "DROP TABLE schedule_firings; DROP TABLE schedules; ALTER TABLE executions DROP COLUMN retry_attempt; ALTER TABLE executions DROP COLUMN parent_execution_id; ALTER TABLE executions DROP COLUMN trigger_kind; DELETE FROM schema_migrations WHERE version=2",
      );
      db.close();
      h = createHub(path, defaultConfig, undefined, 0);
      const d = await detail(h, w.id);
      expect(d.workItem.status).toBe("waiting_input");
      expect(d.agentSession.externalSessionId).toBe("old-session");
      expect(d.interactions[0].status).toBe("open");
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects invalid timezone, expression and malformed later time", async () => {
    const hub = createHub(":memory:", defaultConfig, undefined, 0);
    try {
      for (const options of [
        { kind: "cron", expression: "bad", timezone: "UTC" },
        { kind: "cron", expression: "* * * * *", timezone: "not-a-zone" },
      ])
        expect(
          (
            await post(hub, "/api/schedules", {
              ...options,
              event: { source: "local", type: "demo.cron", payload: {} },
            })
          ).statusCode,
        ).toBe(400);
      const c = (await create(hub, "demo.later")).json();
      const e = (await claim(hub)).json();
      expect(
        (
          await result(hub, e, {
            type: "later",
            sessionId: "s",
            message: "wait",
            afterSeconds: 2,
            runAt: "2026-11-08T00:00:00Z",
          })
        ).statusCode,
      ).toBe(400);
      expect(c.workItem.status).toBe("active");
    } finally {
      await hub.close();
    }
  });
  it("processes competing scheduler processes with one atomic firing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-race-"));
    const path = join(dir, "db");
    let t = Date.parse("2026-11-08T00:00:00Z");
    const hub = createHub(path, defaultConfig, () => t, 0);
    try {
      const s = await post(hub, "/api/schedules", {
        kind: "once",
        runAt: "2026-11-08T00:00:01Z",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      expect(s.statusCode).toBe(200);
      t += 2000;
      const children = [0, 1].map(() =>
        fork(
          join(process.cwd(), "tests", "fixtures", "scheduler-race.mjs"),
          [path, String(t)],
          { stdio: ["ignore", "ignore", "ignore", "ipc"] },
        ),
      );
      const ready = children.map(
        (c) =>
          new Promise<void>((resolve, reject) => {
            c.once("message", (m) =>
              m === "ready" ? resolve() : reject(new Error("not ready")),
            );
            c.once("error", reject);
          }),
      );
      await Promise.all(ready);
      const results = children.map(
        (c) =>
          new Promise<{ count: number }>((resolve, reject) => {
            let value: { count: number } | undefined;
            c.once("message", (m) => {
              value = m as { count: number };
            });
            c.once("exit", (code) =>
              code === 0 && value
                ? resolve(value)
                : reject(new Error("scheduler process failed")),
            );
            c.once("error", reject);
          }),
      );
      children.forEach((c) => c.send("go"));
      const values = await Promise.all(results);
      expect(values.map((x) => x.count).sort()).toEqual([0, 1]);
      expect((await hub.inject("/api/work-items")).json()).toHaveLength(1);
      const db = new DatabaseSync(path);
      expect(
        Number(
          db.prepare("SELECT count(*) AS n FROM schedule_firings").get()?.n,
        ),
      ).toBe(1);
      db.close();
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
  it("runs mock retry, later restart and cron end-to-end over HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-mock-e2e-"));
    const path = join(dir, "db");
    let t = Date.parse("2026-11-08T00:00:00Z");
    let h = createHub(path, defaultConfig, () => t, 0);
    const open = async () => {
      await h.listen({ host: "127.0.0.1", port: 0 });
      const addr = h.server.address();
      if (!addr || typeof addr === "string") throw Error("missing port");
      return `http://127.0.0.1:${addr.port}`;
    };
    try {
      let base = await open();
      const later = (await create(h, "demo.later")).json().workItem;
      await workOnce(base, "w");
      let d = await detail(h, later.id);
      expect(d.workItem.status).toBe("waiting_schedule");
      const sid = d.agentSession.id;
      await h.close();
      t += 3000;
      h = createHub(path, defaultConfig, () => t, 0);
      base = await open();
      expect(h.tickScheduler()).toBe(1);
      await workOnce(base, "w");
      d = await detail(h, later.id);
      expect(d.executions[1].output).toBe("TaskCircuit Later 试跑通过");
      expect(d.executions[1].agentSessionId).toBe(sid);
      const retry = (await create(h, "demo.retry")).json().workItem;
      await workOnce(base, "w");
      expect((await detail(h, retry.id)).workItem.status).toBe(
        "waiting_schedule",
      );
      t += 2000;
      expect(h.tickScheduler()).toBe(1);
      await workOnce(base, "w");
      expect(
        (await detail(h, retry.id)).executions.map((e: any) => e.status),
      ).toEqual(["failed", "completed"]);
      await post(h, "/api/schedules", {
        kind: "cron",
        expression: "* * * * *",
        timezone: "UTC",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      t = Date.parse("2026-11-08T00:01:00Z");
      expect(h.tickScheduler()).toBe(1);
      await workOnce(base, "w");
      const items = (await h.inject("/api/work-items")).json();
      expect(
        items.some(
          (x: any) =>
            x.workItem.title === "试跑 cron" &&
            x.workItem.status === "completed",
        ),
      ).toBe(true);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rolls back firing if event routing fails and succeeds after configuration returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-rollback-"));
    const path = join(dir, "db");
    let t = Date.parse("2026-11-08T00:00:00Z");
    let h = createHub(path, defaultConfig, () => t, 0);
    try {
      await post(h, "/api/schedules", {
        kind: "once",
        runAt: "2026-11-08T00:00:01Z",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      await h.close();
      t += 2000;
      h = createHub(
        path,
        {
          ...defaultConfig,
          routes: defaultConfig.routes.filter(
            (r) => r.event.type !== "demo.cron",
          ),
        },
        () => t,
        0,
      );
      expect(() => h.tickScheduler()).toThrow();
      await h.close();
      const db = new DatabaseSync(path);
      expect(
        Number(
          db.prepare("SELECT count(*) AS n FROM schedule_firings").get()?.n,
        ),
      ).toBe(0);
      expect(
        Number(db.prepare("SELECT count(*) AS n FROM events").get()?.n),
      ).toBe(0);
      db.close();
      h = createHub(path, defaultConfig, () => t, 0);
      expect(h.tickScheduler()).toBe(1);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not duplicate configured schedules on restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-config-sched-"));
    const path = join(dir, "db");
    const t = Date.parse("2026-11-08T00:00:00Z");
    const cfg = {
      ...defaultConfig,
      schedules: [
        {
          id: "daily",
          cron: "0 9 * * *",
          timezone: "UTC",
          event: { source: "local", type: "demo.cron" },
        },
      ],
    };
    let h = createHub(path, cfg, () => t, 0);
    try {
      expect((await h.inject("/api/schedules")).json()).toHaveLength(1);
      await h.close();
      h = createHub(path, cfg, () => t, 0);
      expect((await h.inject("/api/schedules")).json()).toHaveLength(1);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("recovers an overdue retry after restart with its previously established session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-retry-restart-"));
    const path = join(dir, "db");
    let t = Date.parse("2026-11-08T00:00:00Z");
    let h = createHub(path, defaultConfig, () => t, 0);
    try {
      const work = (await create(h, "demo.retry")).json().workItem;
      const first = (await claim(h)).json();
      await result(h, first, { ...failed, sessionId: "existing-session" });
      let d = await detail(h, work.id);
      const sessionId = d.agentSession.id;
      await h.close();
      t += 3000;
      h = createHub(path, defaultConfig, () => t, 0);
      expect(h.tickScheduler()).toBe(1);
      const second = (await claim(h)).json();
      expect(second.execution.agentSessionId).toBe(sessionId);
      expect(second.agentSession.externalSessionId).toBe("existing-session");
      expect(second.execution.triggerKind).toBe("retry");
      expect(second.execution.retryAttempt).toBe(1);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("allows day names containing H without accepting randomized cron expressions", async () => {
    const h = createHub(
      ":memory:",
      defaultConfig,
      () => Date.parse("2026-11-08T00:00:00Z"),
      0,
    );
    try {
      const event = { source: "local", type: "demo.cron", payload: {} };
      expect(
        (
          await post(h, "/api/schedules", {
            kind: "cron",
            expression: "0 9 * * THU",
            timezone: "UTC",
            event,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(h, "/api/schedules", {
            kind: "cron",
            expression: "H 9 * * *",
            timezone: "UTC",
            event,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await h.close();
    }
  });
  it("mock retry preserves a previously created external session", async () => {
    const adapter = new MockAgentAdapter();
    const result = await adapter.execute({
      workItemId: "w",
      executionId: "e",
      workingDirectory: ".",
      instruction: "",
      context: { type: "demo.retry" },
      previousAnswers: [],
      externalSessionId: "existing-session",
      retryAttempt: 1,
    });
    expect(result).toMatchObject({
      type: "completed",
      sessionId: "existing-session",
    });
  });
  it("uses exponential retry delays and stops before each due instant", async () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const config = {
      ...defaultConfig,
      routes: defaultConfig.routes.map((r) =>
        r.event.type === "demo.retry"
          ? {
              ...r,
              retryPolicy: {
                maxAttempts: 3,
                strategy: "exponential" as const,
                initialDelaySeconds: 2,
                maxDelaySeconds: 10,
              },
            }
          : r,
      ),
    };
    const hub = createHub(":memory:", config, () => t, 0);
    try {
      await create(hub);
      const a = (await claim(hub)).json();
      await result(hub, a, failed);
      t += 1999;
      expect(hub.tickScheduler()).toBe(0);
      t++;
      expect(hub.tickScheduler()).toBe(1);
      const b = (await claim(hub)).json();
      await result(hub, b, failed);
      t += 3999;
      expect(hub.tickScheduler()).toBe(0);
      t++;
      expect(hub.tickScheduler()).toBe(1);
    } finally {
      await hub.close();
    }
  });
  it("schedules later at an explicit UTC instant", async () => {
    let t = Date.parse("2026-11-08T00:00:00Z");
    const hub = createHub(":memory:", defaultConfig, () => t, 0);
    try {
      const w = (await create(hub, "demo.later")).json().workItem;
      const c = (await claim(hub)).json();
      expect(
        (
          await result(hub, c, {
            type: "later",
            sessionId: "s",
            message: "wait",
            runAt: "2026-11-08T08:00:02+08:00",
          })
        ).statusCode,
      ).toBe(200);
      expect((await detail(hub, w.id)).schedules[0].nextFireAt).toBe(
        "2026-11-08T00:00:02.000Z",
      );
      t += 2000;
      expect(hub.tickScheduler()).toBe(1);
    } finally {
      await hub.close();
    }
  });
});
