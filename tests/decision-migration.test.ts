// Guards migration atomicity after a real process death, historical events and future schemas.
import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { createHub as oldHub } from "./fixtures/v012-runtime/hub.js";
import { defaultConfig } from "../src/config.js";
import { migrateDomain, createDefinition } from "../src/automation-domain.js";
import { migrateEventCore, ingestEvent } from "../src/event-core.js";
import {
  migrateDecisionCore,
  processPendingDecisions,
} from "../src/decision-core.js";
for (const stage of [
  "decisions-created",
  "indexes-created",
  "constraints-created",
  "before-schema-update",
]) {
  it(`rolls back migration after process death at ${stage}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-m8-"));
    try {
      const path = await resolveCurrentStore(home);
      let db = new DatabaseSync(path);
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      db.close();
      const child = fork(
        join(process.cwd(), "tests/fixtures/migration8-kill.mjs"),
        [path, stage],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("checkpoint timeout")),
            10000,
          );
          child.on("message", (m) => {
            if (m === stage) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once("error", reject);
          child.once("exit", () => {
            clearTimeout(timer);
            reject(Error("child exited early"));
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
          ).toBe(7);
          expect(
            db
              .prepare("SELECT name FROM sqlite_schema WHERE name='decisions'")
              .get(),
          ).toBeUndefined();
          migrateDecisionCore(db);
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(8);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          db.close();
        }
      } finally {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
it("rejects schema 11", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m8-new-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      migrateDecisionCore(db);
      db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(
        "2026-01-01",
      );
      expect(() => migrateDecisionCore(db)).toThrowError(
        expect.objectContaining({ code: "database_schema_too_new" }),
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("upgrades a real v0.1.2 store and preserves pre-migration Events without inventing decisions", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m8-history-"));
  try {
    const legacy = join(home, "taskcircuit.db");
    const old = oldHub(legacy, defaultConfig, () => 0, 0);
    const response = await old.inject({
      method: "POST",
      url: "/api/events",
      payload: { source: "local", type: "demo.color", payload: {} },
    });
    expect(response.statusCode).toBe(200);
    await old.close();
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      migrateEventCore(db);
      createDefinition(db, "historic-auto", "historic", {}, "2026-01-01");
      const event = ingestEvent(
        db,
        { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
        {
          sourceEventId: "before-m8",
          type: "demo.color",
          payload: {},
          automationId: "historic-auto",
          correlationKey: "a",
        },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      );
      expect(event.status).toBe("accepted");
      migrateDecisionCore(db);
      expect(
        processPendingDecisions(db, { config: defaultConfig, now: () => 0 }),
      ).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM decisions").get()?.n).toBe(0);
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(8);
      expect(db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
