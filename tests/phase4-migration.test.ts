import { createHub as oldHub } from "./fixtures/v012-runtime/hub.js";
import { defaultConfig } from "../src/config.js";
// Guards schema 9 atomicity and rejection of unsupported future versions.
import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { migrateDomain } from "../src/automation-domain.js";
import { migrateEventCore } from "../src/event-core.js";
import { migrateDecisionCore } from "../src/decision-core.js";
import { migrateMaterialization } from "../src/decision-materialization.js";
for (const stage of ["created", "before-schema-update"])
  it(`rolls back schema 9 when killed at ${stage}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-m9-"));
    try {
      const path = await resolveCurrentStore(home);
      let db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      db.close();
      const child = fork(
        join(process.cwd(), "tests/fixtures/migration9-kill.mjs"),
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
          ).toBe(8);
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name='decision_materializations'",
              )
              .get(),
          ).toBeUndefined();
          migrateMaterialization(db);
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(9);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          migrateMaterialization(db);
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
  const home = mkdtempSync(join(tmpdir(), "tc-m9-future-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      migrateMaterialization(db);
      db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(
        "2026-01-01",
      );
      expect(() => migrateMaterialization(db)).toThrowError(
        expect.objectContaining({ code: "database_schema_too_new" }),
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("upgrades the archived v0.1.2 store through generation 2 schema 9", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m9-legacy-"));
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
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(9);
      expect(db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(1);
      expect(
        db.prepare("SELECT COUNT(*) n FROM decision_materializations").get()?.n,
      ).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
