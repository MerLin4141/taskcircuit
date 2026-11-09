// Guards tick clock consistency, duplicate-firing isolation, and unrelated SQLite errors.
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { nextCron } from "../src/scheduling.js";

const start = Date.parse("2026-03-08T06:00:00Z");
const post = (
  hub: ReturnType<typeof createHub>,
  url: string,
  payload: unknown,
) => hub.inject({ method: "POST", url, payload });
async function create(hub: ReturnType<typeof createHub>, due: string) {
  const response = await post(hub, "/api/schedules", {
    kind: "once",
    runAt: due,
    event: { source: "local", type: "demo.cron", payload: {} },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "tc-scheduler-fix-"));
  return { dir, path: join(dir, "db") };
}
describe("scheduler clock and isolation", () => {
  it("reads the wall clock exactly once per tick and resumes Cron after a backward jump", async () => {
    const f = temp();
    let now = start;
    let reads = 0;
    let fault = false;
    const hub = createHub(
      f.path,
      defaultConfig,
      () => {
        reads++;
        return fault && reads > 1 ? now - 120000 : now;
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
      const id = created.json().id;
      now += 60000;
      reads = 0;
      fault = true;
      expect(hub.tickScheduler()).toBe(1);
      expect(reads).toBe(1);
      fault = false;
      let state = (await hub.inject(`/api/schedules/${id}`)).json();
      expect(state.lastFireAt).toBe(new Date(now).toISOString());
      expect(state.nextFireAt).toBe(new Date(now + 60000).toISOString());
      reads = 0;
      expect(hub.tickScheduler()).toBe(0);
      expect(reads).toBe(1);
      now += 60000;
      reads = 0;
      expect(hub.tickScheduler()).toBe(1);
      expect(reads).toBe(1);
      state = (await hub.inject(`/api/schedules/${id}`)).json();
      expect(state.lastFireAt).toBe(new Date(now).toISOString());
      const db = new DatabaseSync(f.path, { readOnly: true });
      try {
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM schedule_firings WHERE schedule_id=?",
            )
            .get(id)!.n,
        ).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("isolates an existing duplicate firing, emits diagnostics and processes an independent due schedule", async () => {
    const f = temp();
    let now = start;
    const hub = createHub(f.path, defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const damaged = await create(hub, new Date(now + 1000).toISOString());
      const normal = await create(hub, new Date(now + 2000).toISOString());
      now += 1000;
      expect(hub.tickScheduler()).toBe(1);
      const db = new DatabaseSync(f.path);
      let previous: unknown;
      try {
        previous = db
          .prepare("SELECT * FROM schedule_firings WHERE schedule_id=?")
          .get(damaged.id);
        db.prepare(
          "UPDATE schedules SET status='active',next_fire_at=? WHERE id=?",
        ).run(new Date(now).toISOString(), damaged.id);
      } finally {
        db.close();
      }
      now += 1000;
      expect(hub.tickScheduler()).toBe(1);
      expect(
        (await hub.inject(`/api/schedules/${normal.id}`)).json().status,
      ).toBe("completed");
      expect(
        (await hub.inject(`/api/schedules/${damaged.id}`)).json().status,
      ).toBe("active");
      const check = new DatabaseSync(f.path, { readOnly: true });
      try {
        expect(
          check
            .prepare("SELECT * FROM schedule_firings WHERE schedule_id=?")
            .get(damaged.id),
        ).toEqual(previous);
        expect(
          check.prepare("SELECT COUNT(*) n FROM schedule_firings").get()!.n,
        ).toBe(2);
      } finally {
        check.close();
      }
      const messages = errors.mock.calls.map(([m]) => JSON.parse(String(m)));
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: "schedule_firing_duplicate",
          scheduleId: damaged.id,
          scheduledFor: new Date(now - 1000).toISOString(),
        }),
      );
    } finally {
      errors.mockRestore();
      await hub.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("isolates an incomplete existing firing without assuming it is safe to advance", async () => {
    const f = temp();
    let now = start;
    const hub = createHub(f.path, defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const suspect = await create(hub, new Date(now + 1000).toISOString());
      const normal = await create(hub, new Date(now + 2000).toISOString());
      const db = new DatabaseSync(f.path);
      try {
        db.prepare(
          "INSERT INTO schedule_firings(id,schedule_id,scheduled_for,created_at) VALUES(?,?,?,?)",
        ).run(
          "incomplete-firing",
          suspect.id,
          new Date(now + 1000).toISOString(),
          new Date(now).toISOString(),
        );
      } finally {
        db.close();
      }
      now += 2000;
      expect(hub.tickScheduler()).toBe(1);
      const record = (await hub.inject(`/api/schedules/${suspect.id}`)).json();
      expect(record.status).toBe("active");
      expect(record.nextFireAt).toBe(new Date(start + 1000).toISOString());
      expect(
        (await hub.inject(`/api/schedules/${normal.id}`)).json().status,
      ).toBe("completed");
      const verify = new DatabaseSync(f.path, { readOnly: true });
      try {
        expect(
          verify
            .prepare(
              "SELECT event_id,execution_id FROM schedule_firings WHERE id=?",
            )
            .get("incomplete-firing"),
        ).toMatchObject({ event_id: null, execution_id: null });
      } finally {
        verify.close();
      }
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await hub.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("does not mask an unrelated SQLite constraint error", async () => {
    const f = temp();
    let now = start;
    const hub = createHub(f.path, defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await create(hub, new Date(now + 1000).toISOString());
      const db = new DatabaseSync(f.path);
      try {
        db.exec(
          "CREATE TRIGGER test_unrelated_constraint BEFORE INSERT ON schedule_firings BEGIN SELECT RAISE(ABORT, 'unrelated constraint'); END",
        );
      } finally {
        db.close();
      }
      now += 1000;
      expect(() => hub.tickScheduler()).toThrow(/unrelated constraint/);
    } finally {
      await hub.close();
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
  it("retains five-field cron timezone and daylight-saving calculation", () => {
    expect(
      nextCron(
        "30 2 * * *",
        "America/New_York",
        Date.parse("2026-03-08T05:00:00Z"),
      ),
    ).toBe("2026-03-08T07:30:00.000Z");
    expect(() => nextCron("0 30 2 * * *", "UTC", start)).toThrow();
  });
});
