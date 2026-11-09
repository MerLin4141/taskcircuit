import { createHash } from "node:crypto";
import { createHub as oldHub } from "./fixtures/v012-runtime/hub.js";
import { defaultConfig } from "../src/config.js";
// Guards Migration 10 crash atomicity, restart and future schema rejection.
import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { resolveCurrentStore } from "../src/storage/generation.js";
import {
  migrateDomain,
  createDefinition,
  createRoot,
} from "../src/automation-domain.js";
import { migrateEventCore } from "../src/event-core.js";
import { migrateDecisionCore } from "../src/decision-core.js";
import { migrateMaterialization } from "../src/decision-materialization.js";
import { migrateLoopLimits } from "../src/loop-limits.js";
for (const stage of [
  "columns-added",
  "roots-populated",
  "constraints-created",
  "before-schema-update",
])
  it(`rolls back schema 10 after process kill at ${stage}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-m10-"));
    try {
      const path = await resolveCurrentStore(home);
      let db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      migrateMaterialization(db);
      createDefinition(
        db,
        "a",
        "Auto",
        { loop: { maxRuns: 3, maxDurationSeconds: 60 } },
        "2026-01-01T00:00:00.000Z",
      );
      createRoot(db, "r", "a", 1, null, "2026-01-01T00:00:00.000Z");
      db.close();
      const child = fork(
        join(process.cwd(), "tests/fixtures/migration10-kill.mjs"),
        [path, stage],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("timeout")), 10000);
          child.on("message", (m) => {
            if (m === stage) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once("error", reject);
          child.once("exit", () => {
            clearTimeout(timer);
            reject(Error("early exit"));
          });
        });
        const done = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
        child.kill("SIGKILL");
        await done;
        db = new DatabaseSync(path);
        try {
          db.exec("PRAGMA foreign_keys=ON");
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(9);
          expect(
            db
              .prepare("PRAGMA table_info(automation_roots)")
              .all()
              .some((x) => x.name === "max_runs"),
          ).toBe(false);
          migrateLoopLimits(db);
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(10);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(
            db
              .prepare(
                "SELECT max_runs,deadline_at FROM automation_roots WHERE id='r'",
              )
              .get(),
          ).toMatchObject({
            max_runs: 3,
            deadline_at: "2026-01-01T00:01:00.000Z",
          });
          migrateLoopLimits(db);
        } finally {
          db.close();
        }
      } finally {
        if (child.exitCode === null && !child.killed) child.kill();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
it("rejects schema 11", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m10-future-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      migrateMaterialization(db);
      migrateLoopLimits(db);
      db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(
        "2026-01-01",
      );
      expect(() => migrateLoopLimits(db)).toThrowError(
        expect.objectContaining({ code: "database_schema_too_new" }),
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("rejects a schema 10 database missing its limit guards", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m10-damaged-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      migrateMaterialization(db);
      migrateLoopLimits(db);
      db.exec("DROP TRIGGER root_loop_immutable");
      expect(() => migrateLoopLimits(db)).toThrow();
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("upgrades a real v0.1.2 database to schema 10 without altering Generation 1 during Migration 10", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m10-old-"));
  try {
    const legacy = join(home, "taskcircuit.db");
    const old = oldHub(legacy, defaultConfig, () => 0, 0);
    expect(
      (
        await old.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.color", payload: {} },
        })
      ).statusCode,
    ).toBe(200);
    await old.close();
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      migrateMaterialization(db);
      const hash = () =>
        createHash("sha256").update(readFileSync(legacy)).digest("hex");
      const before = hash();
      migrateLoopLimits(db);
      expect(hash()).toBe(before);
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(10);
      expect(db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(1);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
