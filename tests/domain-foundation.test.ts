// A schema upgrade must preserve old work and never leave it without a root.
import { it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resultDigest } from "../src/result-receipt.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHub } from "../src/hub.js";
import { createHub as oldHub } from "./fixtures/v012-runtime/hub.js";
import { defaultConfig } from "./fixtures/v012-runtime/config.js";
import { resolveCurrentStore } from "../src/storage/generation.js";
import {
  migrateDomain,
  canTransitionRoot,
  createDefinition,
  addDefinitionVersion,
  createRoot,
  transitionRoot,
  createWorkItemForRoot,
} from "../src/automation-domain.js";

it("upgrades an actual v0.1.2 database through generation 2 with unique roots", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-"));
  const legacy = join(home, "taskcircuit.db");
  const old = oldHub(legacy, defaultConfig, undefined, 0, {
    dispatcherPollMs: 0,
  });
  try {
    for (let i = 0; i < 2; i++)
      expect(
        (
          await old.inject({
            method: "POST",
            url: "/api/events",
            payload: { source: "local", type: "demo.color", payload: { i } },
          })
        ).statusCode,
      ).toBe(200);
    await old.close();
    const current = await resolveCurrentStore(home);
    const db = new DatabaseSync(current);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const before = db.prepare("SELECT id FROM work_items ORDER BY id").all();
      migrateDomain(db);
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(6);
      expect(db.prepare("SELECT id FROM work_items ORDER BY id").all()).toEqual(
        before,
      );
      expect(
        db.prepare("SELECT COUNT(DISTINCT root_id) n FROM work_items").get()?.n,
      ).toBe(2);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        db
          .prepare("PRAGMA table_info(work_items)")
          .all()
          .find((x) => x.name === "root_id")?.notnull,
      ).toBe(1);
      migrateDomain(db);
      expect(
        db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
      ).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    await old.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps legacy event creation atomic and assigns a distinct manual root", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-hub-"));
  try {
    const current = await resolveCurrentStore(home);
    const hub = createHub(current, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const result = await hub.inject({
        method: "POST",
        url: "/api/events",
        payload: { source: "local", type: "demo.color", payload: {} },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().workItem.rootId).toBeTruthy();
      const db = new DatabaseSync(current, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT root_id FROM work_items WHERE id=?")
            .get(result.json().workItem.id)?.root_id,
        ).toBeTruthy();
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("pins immutable definition versions and rejects terminal reopen", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-roots-"));
  try {
    const current = await resolveCurrentStore(home);
    const db = new DatabaseSync(current);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      createDefinition(
        db,
        "a",
        "Example",
        { profile: "one" },
        "2026-01-01T00:00:00Z",
      );
      createRoot(db, "r1", "a", 1, null, "2026-01-01T00:00:00Z");
      addDefinitionVersion(
        db,
        "a",
        2,
        { profile: "two" },
        "2026-01-01T00:00:01Z",
      );
      createRoot(db, "r2", "a", 2, null, "2026-01-01T00:00:01Z");
      expect(
        db
          .prepare(
            "SELECT definition_version FROM automation_roots WHERE id='r1'",
          )
          .get()?.definition_version,
      ).toBe(1);
      expect(
        db
          .prepare(
            "SELECT definition_version FROM automation_roots WHERE id='r2'",
          )
          .get()?.definition_version,
      ).toBe(2);
      expect(() =>
        db.exec(
          "UPDATE automation_definition_versions SET config_snapshot_json='{}' WHERE definition_id='a' AND version=1",
        ),
      ).toThrow();
      expect(() =>
        db.exec(
          "UPDATE automation_roots SET definition_version=2 WHERE id='r1'",
        ),
      ).toThrow();
      expect(canTransitionRoot("completed", "active")).toBe(false);
      expect(canTransitionRoot("active", "waiting")).toBe(true);
      expect(() => transitionRoot(db, "r2", "cancelled")).toThrow();
      expect(() => transitionRoot(db, "r1", "completed")).toThrow();
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)").run(
        "p",
        "p",
        "mock",
        null,
        null,
        "{}",
      );
      createWorkItemForRoot(db, {
        rootId: "r1",
        id: "wi",
        executionId: "ex",
        profileId: "p",
        at: "2026-01-01T00:00:00Z",
      });
      expect(() => transitionRoot(db, "r1", "completed")).toThrow();
      db.prepare(
        "UPDATE executions SET status='completed' WHERE id='ex'",
      ).run();
      db.prepare(
        "UPDATE work_items SET status='completed' WHERE id='wi'",
      ).run();
      expect(() => transitionRoot(db, "r1", "active")).toThrow();
      expect(() =>
        db.exec("UPDATE automation_roots SET status='active' WHERE id='r1'"),
      ).toThrow();
      createRoot(db, "r3", "a", 2, "r1", "2026-01-01T00:00:02Z");
      expect(() =>
        db.exec(
          "UPDATE automation_roots SET predecessor_root_id='r3' WHERE id='r1'",
        ),
      ).toThrow();
      expect(() =>
        createRoot(db, "r4", "a", 2, "r2", "2026-01-01T00:00:02Z"),
      ).toThrow();
      expect(() =>
        createRoot(db, "r5", "a", 2, "r5", "2026-01-01T00:00:02Z"),
      ).toThrow();
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("tracks Ask, Answer and completion on the same root and session", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-flow-"));
  try {
    const current = await resolveCurrentStore(home);
    const hub = createHub(current, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const post = (url: string, payload: unknown) =>
      hub.inject({ method: "POST", url, payload });
    const db = new DatabaseSync(current, { readOnly: true });
    try {
      const work = (
        await post("/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json().workItem;
      const rootState = () =>
        db
          .prepare("SELECT status FROM automation_roots WHERE id=?")
          .get(work.rootId)?.status;
      const a = (await post("/api/executions/claim", { workerId: "w" })).json();
      expect(
        (
          await post(`/api/executions/${a.execution.id}/result`, {
            workerId: "w",
            leaseToken: a.leaseToken,
            result: {
              type: "needs_input",
              sessionId: "same-session",
              request: { title: "q", text: "q", key: "q", options: ["yes"] },
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(rootState()).toBe("waiting");
      const detail = (await hub.inject(`/api/work-items/${work.id}`)).json();
      expect(
        (
          await post(`/api/interactions/${detail.interactions[0].id}/answer`, {
            answer: "yes",
          })
        ).statusCode,
      ).toBe(200);
      expect(rootState()).toBe("active");
      const b = (await post("/api/executions/claim", { workerId: "w" })).json();
      expect(b.agentSession.externalSessionId).toBe("same-session");
      expect(
        (
          await post(`/api/executions/${b.execution.id}/result`, {
            workerId: "w",
            leaseToken: b.leaseToken,
            result: {
              type: "completed",
              sessionId: "same-session",
              output: "done",
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(rootState()).toBe("completed");
    } finally {
      db.close();
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("rejects binding another Work Item session across roots", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-session-"));
  try {
    const current = await resolveCurrentStore(home);
    const hub = createHub(current, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const post = (url: string, payload: unknown) =>
      hub.inject({ method: "POST", url, payload });
    try {
      await post("/api/events", {
        source: "local",
        type: "demo.color",
        payload: {},
      });
      const b = (
        await post("/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json();
      const claim = (
        await post("/api/executions/claim", { workerId: "w" })
      ).json();
      expect(
        (
          await post(`/api/executions/${claim.execution.id}/result`, {
            workerId: "w",
            leaseToken: claim.leaseToken,
            result: {
              type: "completed",
              sessionId: "session-a",
              output: "done",
            },
          })
        ).statusCode,
      ).toBe(200);
      const db = new DatabaseSync(current);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        const session = db
          .prepare("SELECT id FROM agent_sessions LIMIT 1")
          .get()?.id;
        expect(() =>
          db
            .prepare("UPDATE executions SET agent_session_id=? WHERE id=?")
            .run(session as string, b.execution.id),
        ).toThrow();
        expect(() =>
          db
            .prepare("INSERT INTO agent_sessions VALUES(?,?,?,?,?,?,?,?)")
            .run(
              "different-id",
              b.workItem.id,
              "mock",
              "session-a",
              "active",
              "2026-01-01",
              "2026-01-01",
              "{}",
            ),
        ).toThrow();
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const stage of [
  "definitions-created",
  "roots-created",
  "legacy-populating",
  "before-work-constraint",
  "before-schema-update",
]) {
  it(`rolls back after process termination at ${stage}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-m6-kill-"));
    const legacy = oldHub(
      join(home, "taskcircuit.db"),
      defaultConfig,
      undefined,
      0,
      { dispatcherPollMs: 0 },
    );
    try {
      await legacy.inject({
        method: "POST",
        url: "/api/events",
        payload: { source: "local", type: "demo.color", payload: {} },
      });
      await legacy.close();
      const current = await resolveCurrentStore(home);
      const child = fork(
        join(process.cwd(), "tests/fixtures/migration6-kill.mjs"),
        [current, stage],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("migration child timeout")),
            10000,
          );
          child.on("message", (msg) => {
            if (msg === stage) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once("error", reject);
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("child exited before checkpoint"));
          });
        });
        const exit = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );
        child.kill("SIGKILL");
        await exit;
        const db = new DatabaseSync(current);
        try {
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(5);
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name='automation_roots'",
              )
              .get(),
          ).toBeUndefined();
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          migrateDomain(db);
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(6);
        } finally {
          db.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    } finally {
      await legacy.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
}

it("serializes agent claims for multiple work items of the same root", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-claims-"));
  try {
    const current = await resolveCurrentStore(home);
    const hub = createHub(current, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const db = new DatabaseSync(current);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)").run(
        "p",
        "p",
        "mock",
        null,
        null,
        "{}",
      );
      createDefinition(db, "a", "Example", {}, "2026-01-01T00:00:00Z");
      db.prepare(
        "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,created_at,updated_at) VALUES('r','a',1,'manual','created',?,?)",
      ).run("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      createWorkItemForRoot(db, {
        rootId: "r",
        id: "w1",
        executionId: "e1",
        profileId: "p",
        at: "2026-01-01T00:00:00Z",
      });
      createWorkItemForRoot(db, {
        rootId: "r",
        id: "w2",
        executionId: "e2",
        profileId: "p",
        at: "2026-01-01T00:00:00Z",
      });
      const claim = (workerId: string) =>
        hub.inject({
          method: "POST",
          url: "/api/executions/claim",
          payload: { workerId },
        });
      expect((await claim("first")).statusCode).toBe(200);
      expect((await claim("second")).statusCode).toBe(204);
    } finally {
      db.close();
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

for (const count of [100, 1000]) {
  it(`migrates ${count} distinct historical work items without merging roots`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-m6-volume-"));
    const old = oldHub(
      join(home, "taskcircuit.db"),
      defaultConfig,
      undefined,
      0,
      { dispatcherPollMs: 0 },
    );
    try {
      await old.close();
      const legacy = new DatabaseSync(join(home, "taskcircuit.db"));
      try {
        legacy.exec("BEGIN IMMEDIATE");
        legacy
          .prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)")
          .run("p", "p", "mock", null, null, "{}");
        const insert = legacy.prepare(
          "INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?)",
        );
        for (let i = 0; i < count; i++)
          insert.run(
            `work-${i}`,
            "task",
            "active",
            "r",
            "p",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
            null,
            "{}",
          );
        legacy.exec("COMMIT");
      } finally {
        legacy.close();
      }
      const current = await resolveCurrentStore(home);
      const db = new DatabaseSync(current);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        migrateDomain(db);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n,COUNT(DISTINCT root_id) roots FROM work_items",
            )
            .get(),
        ).toMatchObject({ n: count, roots: count });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM automation_roots WHERE mode='legacy'",
            )
            .get()?.n,
        ).toBe(count);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      await old.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

it("preserves legacy child records and leaves the quarantined generation unchanged", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-history-"));
  const path = join(home, "taskcircuit.db");
  const old = oldHub(path, defaultConfig, undefined, 0, {
    dispatcherPollMs: 0,
  });
  const post = (url: string, payload: unknown) =>
    old.inject({ method: "POST", url, payload });
  try {
    await post("/api/events", {
      source: "local",
      type: "demo.color",
      payload: {},
    });
    const claim = (
      await post("/api/executions/claim", { workerId: "seed" })
    ).json();
    const result = {
      type: "needs_input",
      sessionId: "persisted-session",
      request: { title: "q", text: "q", key: "k", options: ["yes"] },
    };
    expect(
      (
        await post(`/api/executions/${claim.execution.id}/result`, {
          workerId: "seed",
          leaseToken: claim.leaseToken,
          submissionId: randomUUID(),
          resultDigest: resultDigest(result),
          result,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post("/api/schedules", {
          kind: "once",
          runAt: "2030-01-01T00:00:00Z",
          event: { source: "local", type: "demo.color", payload: {} },
        })
      ).statusCode,
    ).toBe(200);
    await old.close();
    const current = await resolveCurrentStore(home);
    const legacyHash = createHash("sha256")
      .update(readFileSync(path))
      .digest("hex");
    const db = new DatabaseSync(current);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','work_items')",
        )
        .all()
        .map((r) => String(r.name));
      const before = new Map(
        tables.map((name) => [
          name,
          db.prepare(`SELECT * FROM "${name}"`).all(),
        ]),
      );
      const works = db
        .prepare(
          "SELECT id,title,status,route_id,agent_profile_id,created_at,updated_at,completed_at,metadata FROM work_items",
        )
        .all();
      expect(db.prepare("SELECT COUNT(*) n FROM agent_sessions").get()?.n).toBe(
        1,
      );
      expect(db.prepare("SELECT COUNT(*) n FROM interactions").get()?.n).toBe(
        1,
      );
      expect(db.prepare("SELECT COUNT(*) n FROM notifications").get()?.n).toBe(
        1,
      );
      migrateDomain(db);
      for (const table of tables)
        expect(db.prepare(`SELECT * FROM "${table}"`).all()).toEqual(
          before.get(table),
        );
      expect(
        db
          .prepare(
            "SELECT id,title,status,route_id,agent_profile_id,created_at,updated_at,completed_at,metadata FROM work_items",
          )
          .all(),
      ).toEqual(works);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM work_items WHERE json_extract(metadata,'$.taskcircuitResultReceiptsV1') IS NOT NULL",
          )
          .get()?.n,
      ).toBe(1);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      legacyHash,
    );
  } finally {
    await old.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("maps every historical work status and blocks unknown or running execution", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-map-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)").run(
        "p",
        "p",
        "mock",
        null,
        null,
        "{}",
      );
      const insert = db.prepare(
        "INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const status of [
        "active",
        "waiting_input",
        "waiting_schedule",
        "completed",
        "failed",
        "cancelled",
        "unknown",
        "running",
      ])
        insert.run(
          status,
          status,
          ["unknown", "running"].includes(status) ? "active" : status,
          "r",
          "p",
          "2026-01-01",
          "2026-01-01",
          status === "completed" ? "2026-01-02" : null,
          "{}",
        );
      const exe = db.prepare(
        "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,not_before,input,error,created_at) VALUES(?,?,1,?,'p','2026-01-01','{}',?,'2026-01-01')",
      );
      exe.run(
        "e-unknown",
        "unknown",
        "failed",
        JSON.stringify({ code: "execution_outcome_unknown" }),
      );
      exe.run("e-running", "running", "running", null);
      migrateDomain(db);
      const got = Object.fromEntries(
        db
          .prepare(
            "SELECT w.id,r.status FROM work_items w JOIN automation_roots r ON r.id=w.root_id",
          )
          .all()
          .map((r) => [r.id, r.status]),
      );
      expect(got).toEqual({
        active: "active",
        waiting_input: "waiting",
        waiting_schedule: "waiting",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
        unknown: "blocked",
        running: "blocked",
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it("refuses an unrecognized historical state instead of inventing a mapping", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-state-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)").run(
        "p",
        "p",
        "mock",
        null,
        null,
        "{}",
      );
      db.prepare("INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?)").run(
        "x",
        "x",
        "unexpected",
        "r",
        "p",
        "2026-01-01",
        "2026-01-01",
        null,
        "{}",
      );
      expect(() => migrateDomain(db)).toThrow();
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(5);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("retains database constraints and the singleton system definition", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-schema-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      const columns = db.prepare("PRAGMA table_info(work_items)").all();
      expect(columns.find((c) => c.name === "root_id")?.notnull).toBe(1);
      expect(
        db
          .prepare("PRAGMA foreign_key_list(work_items)")
          .all()
          .some((f) => f.from === "root_id" && f.table === "automation_roots"),
      ).toBe(true);
      expect(
        db
          .prepare("PRAGMA foreign_key_list(automation_roots)")
          .all()
          .some(
            (f) =>
              f.from === "predecessor_root_id" &&
              f.table === "automation_roots",
          ),
      ).toBe(true);
      expect(
        db
          .prepare("PRAGMA foreign_key_list(automation_roots)")
          .all()
          .some((f) => f.table === "automation_definition_versions"),
      ).toBe(true);
      expect(
        db
          .prepare("PRAGMA index_list(automation_definition_versions)")
          .all()
          .some((i) => i.unique === 1),
      ).toBe(true);
      expect(
        db
          .prepare("PRAGMA index_list(work_items)")
          .all()
          .some((i) => i.name === "work_items_root"),
      ).toBe(true);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM automation_definitions WHERE id='system/manual'",
          )
          .get()?.n,
      ).toBe(1);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM automation_definition_versions WHERE definition_id='system/manual'",
          )
          .get()?.n,
      ).toBe(1);
      expect(() =>
        db
          .prepare(
            "INSERT INTO work_items(id,title,status,route_id,agent_profile_id,created_at,updated_at,metadata,root_id) VALUES('x','x','active','r','p','a','a','{}',NULL)",
          )
          .run(),
      ).toThrow();
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("does not complete a root while an active schedule remains", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-pending-"));
  try {
    const path = await resolveCurrentStore(home);
    const hub = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const work = (
        await hub.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.color", payload: {} },
        })
      ).json().workItem;
      const db = new DatabaseSync(path);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        db.prepare(
          "INSERT INTO schedules(id,kind,status,owner_kind,owner_id,reason,created_at,updated_at) VALUES('s','once','active','work_item',?,'later','2026-01-01','2026-01-01')",
        ).run(work.id);
        db.prepare(
          "UPDATE work_items SET status='completed',updated_at='2026-01-02' WHERE id=?",
        ).run(work.id);
        expect(
          db
            .prepare("SELECT status FROM automation_roots WHERE id=?")
            .get(work.rootId)?.status,
        ).not.toBe("completed");
        db.prepare(
          "UPDATE executions SET status='completed' WHERE work_item_id=?",
        ).run(work.id);
        db.exec("UPDATE schedules SET status='cancelled' WHERE id='s'");
        expect(
          db
            .prepare("SELECT status FROM automation_roots WHERE id=?")
            .get(work.rootId)?.status,
        ).toBe("completed");
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("creates a rooted manual work item using the work create CLI alias", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-cli-"));
  try {
    const path = await resolveCurrentStore(home);
    const hub = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      const run = promisify(execFile);
      const result = await run(
        process.execPath,
        ["dist/cli.js", "work", "create", "demo.color", "--json"],
        {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            TASKCIRCUIT_HOME: home,
            TASKCIRCUIT_PORT: new URL(base).port,
          },
        },
      );
      const body = JSON.parse(result.stdout);
      expect(body.workItem.rootId).toBeTruthy();
      const detail = (
        await hub.inject(`/api/work-items/${body.workItem.id}`)
      ).json();
      expect(detail.workItem.rootId).toBe(body.workItem.rootId);
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("does not automatically reactivate a blocked root when a child changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-blocked-"));
  try {
    const path = await resolveCurrentStore(home);
    const hub = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const work = (
        await hub.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.color", payload: {} },
        })
      ).json().workItem;
      const db = new DatabaseSync(path);
      try {
        transitionRoot(db, work.rootId, "blocked");
        db.prepare(
          "UPDATE executions SET status='cancelled' WHERE work_item_id=?",
        ).run(work.id);
        expect(
          db
            .prepare("SELECT status FROM automation_roots WHERE id=?")
            .get(work.rootId)?.status,
        ).toBe("blocked");
        expect(() => transitionRoot(db, work.rootId, "active")).toThrow();
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("preserves duplicate historical external session identifiers but blocks both roots", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-duplicate-session-"));
  const old = oldHub(
    join(home, "taskcircuit.db"),
    defaultConfig,
    undefined,
    0,
    { dispatcherPollMs: 0 },
  );
  const post = (url: string, payload: unknown) =>
    old.inject({ method: "POST", url, payload });
  try {
    for (let i = 0; i < 2; i++) {
      await post("/api/events", {
        source: "local",
        type: "demo.color",
        payload: { i },
      });
      const claim = (
        await post("/api/executions/claim", { workerId: "seed" })
      ).json();
      expect(
        (
          await post(`/api/executions/${claim.execution.id}/result`, {
            workerId: "seed",
            leaseToken: claim.leaseToken,
            result: {
              type: "needs_input",
              sessionId: "same-external-id",
              request: { title: "q", text: "q", key: "q", options: ["yes"] },
            },
          })
        ).statusCode,
      ).toBe(200);
    }
    await old.close();
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const sessions = db
        .prepare("SELECT * FROM agent_sessions ORDER BY id")
        .all();
      migrateDomain(db);
      expect(
        db.prepare("SELECT * FROM agent_sessions ORDER BY id").all(),
      ).toEqual(sessions);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM automation_roots WHERE status='blocked'",
          )
          .get()?.n,
      ).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    await old.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("does not create executions from answers or due schedules on blocked roots", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-blocked-requests-"));
  let now = Date.parse("2026-01-01T00:00:00Z");
  try {
    const path = await resolveCurrentStore(home);
    const hub = createHub(path, defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    const post = (url: string, payload: unknown) =>
      hub.inject({ method: "POST", url, payload });
    try {
      const asked = (
        await post("/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json().workItem;
      const a = (await post("/api/executions/claim", { workerId: "w" })).json();
      await post(`/api/executions/${a.execution.id}/result`, {
        workerId: "w",
        leaseToken: a.leaseToken,
        result: {
          type: "needs_input",
          sessionId: "ask-session",
          request: { title: "q", text: "q", key: "q", options: ["yes"] },
        },
      });
      const question = (await hub.inject(`/api/work-items/${asked.id}`)).json()
        .interactions[0].id;
      const later = (
        await post("/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json().workItem;
      const b = (await post("/api/executions/claim", { workerId: "w" })).json();
      await post(`/api/executions/${b.execution.id}/result`, {
        workerId: "w",
        leaseToken: b.leaseToken,
        result: {
          type: "later",
          sessionId: "later-session",
          message: "later",
          afterSeconds: 2,
        },
      });
      const db = new DatabaseSync(path);
      try {
        transitionRoot(db, asked.rootId, "blocked");
        transitionRoot(db, later.rootId, "blocked");
        expect(
          (
            await post(`/api/interactions/${question}/answer`, {
              answer: "yes",
            })
          ).statusCode,
        ).toBe(409);
        now += 3000;
        expect(hub.tickScheduler()).toBe(0);
        expect(
          db
            .prepare(
              "SELECT COUNT(*) n FROM executions WHERE work_item_id IN (?,?)",
            )
            .get(asked.id, later.id)?.n,
        ).toBe(2);
        expect(
          db.prepare("SELECT status FROM interactions WHERE id=?").get(question)
            ?.status,
        ).toBe("open");
        expect(
          db.prepare("SELECT COUNT(*) n FROM schedule_firings").get()?.n,
        ).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("serializes concurrent Migration 6 processes and reopens schema 6", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-concurrent-"));
  try {
    const path = await resolveCurrentStore(home);
    const children = [0, 1].map(() =>
      fork(join(process.cwd(), "tests/fixtures/migration6-race.mjs"), [path], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      }),
    );
    try {
      let readyCount = 0;
      const result = children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("migration race timeout")),
              10000,
            );
            child.on("message", (msg) => {
              if (msg === "ready") {
                readyCount++;
                if (readyCount === children.length)
                  for (const c of children) c.send("go");
              } else if (msg === "done") {
                clearTimeout(timer);
                resolve();
              } else if (typeof msg === "object" && msg && "error" in msg) {
                clearTimeout(timer);
                reject(new Error(String(msg.error)));
              }
            });
            child.once("error", reject);
          }),
      );
      await Promise.all(result);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((r) => child.once("exit", () => r()));
      expect(await resolveCurrentStore(home)).toBe(path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT COUNT(*) n FROM schema_migrations WHERE version=6")
            .get()?.n,
        ).toBe(1);
        expect(
          db.prepare("SELECT COUNT(*) n FROM automation_definitions").get()?.n,
        ).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("enforces one work item per Root and known subject without inventing legacy subjects", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-subject-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateDomain(db);
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)").run(
        "p",
        "p",
        "mock",
        null,
        null,
        "{}",
      );
      createDefinition(db, "a", "Example", {}, "2026-01-01T00:00:00Z");
      createRoot(db, "r", "a", 1, null, "2026-01-01T00:00:00Z");
      createWorkItemForRoot(db, {
        rootId: "r",
        id: "w1",
        executionId: "e1",
        profileId: "p",
        at: "2026-01-01T00:00:00Z",
        subjectScope: "test",
        subjectKey: "subject",
      });
      expect(() =>
        createWorkItemForRoot(db, {
          rootId: "r",
          id: "w2",
          executionId: "e2",
          profileId: "p",
          at: "2026-01-01T00:00:00Z",
          subjectScope: "test",
          subjectKey: "subject",
        }),
      ).toThrow();
      expect(
        db.prepare("SELECT COUNT(*) n FROM work_items WHERE root_id='r'").get()
          ?.n,
      ).toBe(1);
      expect(
        db.prepare("SELECT COUNT(*) n FROM executions WHERE id='e2'").get()?.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("cannot mark a Root terminal while an Agent is still active", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-terminal-running-"));
  try {
    const path = await resolveCurrentStore(home);
    const hub = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const work = (
        await hub.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.color", payload: {} },
        })
      ).json().workItem;
      expect(
        (
          await hub.inject({
            method: "POST",
            url: "/api/executions/claim",
            payload: { workerId: "w" },
          })
        ).statusCode,
      ).toBe(200);
      const db = new DatabaseSync(path);
      try {
        for (const status of ["failed", "expired", "budget_exhausted"] as const)
          expect(() => transitionRoot(db, work.rootId, status)).toThrow();
      } finally {
        db.close();
      }
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("releases the database when Hub startup refuses an invalid migration", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-startup-fail-"));
  try {
    const path = await resolveCurrentStore(home);
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?)").run(
        "p",
        "p",
        "mock",
        null,
        null,
        "{}",
      );
      db.prepare("INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?)").run(
        "x",
        "x",
        "unexpected",
        "r",
        "p",
        "2026-01-01",
        "2026-01-01",
        null,
        "{}",
      );
    } finally {
      db.close();
    }
    expect(() =>
      createHub(path, defaultConfig, undefined, 0, { dispatcherPollMs: 0 }),
    ).toThrow();
    const rename = path + ".moved";
    (await import("node:fs")).renameSync(path, rename);
    (await import("node:fs")).renameSync(rename, path);
    const repair = new DatabaseSync(path);
    try {
      repair
        .prepare("UPDATE work_items SET status='active' WHERE id='x'")
        .run();
    } finally {
      repair.close();
    }
    const hub = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    await hub.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("refuses an uncut legacy store at every Hub entry point", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-no-bypass-"));
  const path = join(home, "taskcircuit.db");
  const old = oldHub(path, defaultConfig, undefined, 0, {
    dispatcherPollMs: 0,
  });
  await old.close();
  try {
    expect(() =>
      createHub(path, defaultConfig, undefined, 0, { dispatcherPollMs: 0 }),
    ).toThrow();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
      ).toBe(4);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE name='taskcircuit_generation'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  } finally {
    await old.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("does not create a database when given an uninitialized Hub path", () => {
  const home = mkdtempSync(join(tmpdir(), "tc-m6-missing-"));
  const path = join(home, "taskcircuit.db");
  try {
    expect(() => createHub(path, defaultConfig)).toThrow();
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
