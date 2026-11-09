// Guards finite trusted loop limits and their immutable Root deadline across restarts.
import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../src/storage/generation.js";
import {
  migrateDomain,
  createDefinition,
  createRoot,
} from "../src/automation-domain.js";
import { migrateEventCore } from "../src/event-core.js";
import { migrateDecisionCore } from "../src/decision-core.js";
import { migrateMaterialization } from "../src/decision-materialization.js";
import { loopConfig, migrateLoopLimits } from "../src/loop-limits.js";
it("defaults missing loop values to finite limits and rejects unsafe values", () => {
  expect(loopConfig({})).toEqual({ maxRuns: 8, maxDurationSeconds: 7200 });
  expect(loopConfig({ loop: { maxRuns: 3, maxDurationSeconds: 60 } })).toEqual({
    maxRuns: 3,
    maxDurationSeconds: 60,
  });
  for (const x of [0, -1, 1001, 1.5, "8", null])
    expect(() => loopConfig({ loop: { maxRuns: x } })).toThrow();
  for (const x of [0, -1, 31536001, 1.5, "never", null])
    expect(() => loopConfig({ loop: { maxDurationSeconds: x } })).toThrow();
});
it("migrates schema 9 Root limits using pinned Definition and creation time", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-p5-migration-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      migrateMaterialization(db);
      createDefinition(
        db,
        "a",
        "a",
        { loop: { maxRuns: 3, maxDurationSeconds: 60 } },
        "2026-01-01T00:00:00.000Z",
      );
      createRoot(db, "r", "a", 1, null, "2026-01-01T00:00:00.000Z");
      migrateLoopLimits(db);
      expect(
        db
          .prepare(
            "SELECT max_runs,deadline_at FROM automation_roots WHERE id='r'",
          )
          .get(),
      ).toMatchObject({ max_runs: 3, deadline_at: "2026-01-01T00:01:00.000Z" });
      expect(() =>
        db
          .prepare("UPDATE automation_roots SET max_runs=100 WHERE id='r'")
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare("UPDATE automation_roots SET mode='manual' WHERE id='r'")
          .run(),
      ).toThrow();
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(10);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("counts unknown outcomes conservatively while excluding proven pre-start failures", async () => {
  const { runCount } = await import("../src/execution-admission.js");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `CREATE TABLE work_items(id TEXT PRIMARY KEY,root_id TEXT); CREATE TABLE executions(work_item_id TEXT,started_at TEXT,status TEXT,error TEXT); INSERT INTO work_items VALUES('w','r'); INSERT INTO executions VALUES('w','2026-01-01','failed','{"code":"execution_outcome_unknown"}'); INSERT INTO executions VALUES('w','2026-01-01','failed','{"code":"agent_execution","safeToRetry":true}');`,
    );
    expect(runCount(db, "r")).toBe(1);
  } finally {
    db.close();
  }
});

it("conservatively counts legacy malformed errors", async () => {
  const { runCount } = await import("../src/execution-admission.js");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `CREATE TABLE work_items(id TEXT PRIMARY KEY,root_id TEXT); CREATE TABLE executions(work_item_id TEXT,started_at TEXT,status TEXT,error TEXT); INSERT INTO work_items VALUES('w','r'); INSERT INTO executions VALUES('w','2026-01-01','failed','not-json');`,
    );
    expect(runCount(db, "r")).toBe(1);
  } finally {
    db.close();
  }
});
