// Guards durable Event identity, trusted correlation and separation from Agent execution.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHub } from "../src/hub.js";
import { createHub as oldHub } from "./fixtures/v012-runtime/hub.js";
import { defaultConfig } from "./fixtures/v012-runtime/config.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { migrateDomain, createDefinition } from "../src/automation-domain.js";
import { migrateEventCore, ingestEvent } from "../src/event-core.js";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "tc-event-core-"));
  const path = await resolveCurrentStore(home);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  migrateDomain(db);
  migrateEventCore(db);
  createDefinition(db, "automation-a", "A", {}, "2026-01-01T00:00:00Z");
  return {
    home,
    path,
    db,
    close() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const source = {
  sourceInstance: "local-cli",
  trustContext: "trusted_local_cli" as const,
};
const event = (id: string, key = "topic-a") => ({
  sourceEventId: id,
  type: "demo.color",
  payload: { x: 1 },
  correlationKey: key,
  automationId: "automation-a",
});
const ingest = (db: DatabaseSync, body: ReturnType<typeof event>) =>
  ingestEvent(db, source, body, {
    knownTypes: new Set(["demo.color"]),
    now: () => Date.parse("2026-01-01T00:00:00Z"),
  });

describe("event identity and root correlation", () => {
  it("persists one Event, Root and delivery and replays the same receipt", async () => {
    const f = await setup();
    try {
      const a = ingest(f.db, event("d1"));
      const b = ingest(f.db, event("d1"));
      expect(a.status).toBe("accepted");
      expect(b.status).toBe("duplicate");
      expect(b.eventId).toBe(a.eventId);
      expect(b.rootId).toBe(a.rootId);
      expect(
        f.db.prepare("SELECT status FROM event_deliveries").get()?.status,
      ).toBe("processed");
      expect(b.createdRoot).toBe(a.createdRoot);
      expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(1);
      expect(
        f.db.prepare("SELECT COUNT(*) n FROM event_deliveries").get()?.n,
      ).toBe(1);
      expect(
        f.db
          .prepare("SELECT state FROM event_delivery_history ORDER BY sequence")
          .all()
          .map((r) => r.state),
      ).toEqual([
        "received",
        "validated",
        "deduplicated",
        "correlated",
        "routed",
        "processed",
        "duplicate",
      ]);
      expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(
        0,
      );
      expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
        0,
      );
    } finally {
      f.close();
    }
  });
  it("rejects a changed payload for the same delivery identity without changing the accepted Event", async () => {
    const f = await setup();
    try {
      const a = ingest(f.db, event("d1"));
      const conflict = ingest(f.db, { ...event("d1"), payload: { x: 2 } });
      expect(conflict.status).toBe("conflict");
      expect(conflict.eventId).toBe(a.eventId);
      expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(1);
      expect(
        f.db.prepare("SELECT COUNT(*) n FROM event_delivery_conflicts").get()
          ?.n,
      ).toBe(1);
    } finally {
      f.close();
    }
  });
  it("correlates distinct deliveries to one active Root and creates a successor after termination", async () => {
    const f = await setup();
    try {
      const a = ingest(f.db, event("d1"));
      const b = ingest(f.db, event("d2"));
      const c = ingest(f.db, event("d3", "topic-b"));
      expect(b.rootId).toBe(a.rootId);
      expect(c.rootId).not.toBe(a.rootId);
      f.db
        .prepare("UPDATE automation_roots SET status='failed' WHERE id=?")
        .run(a.rootId!);
      const d = ingest(f.db, event("d4"));
      expect(d.rootId).not.toBe(a.rootId);
      expect(
        f.db
          .prepare(
            "SELECT predecessor_root_id FROM automation_roots WHERE id=?",
          )
          .get(d.rootId!)?.predecessor_root_id,
      ).toBe(a.rootId);
    } finally {
      f.close();
    }
  });
  it("persists unknown types as unroutable without Root creation", async () => {
    const f = await setup();
    try {
      const r = ingestEvent(
        f.db,
        source,
        { ...event("u1"), type: "custom.unknown" },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      );
      expect(r.status).toBe("unroutable");
      expect(r.rootId).toBeNull();
      const replay = ingestEvent(
        f.db,
        source,
        { ...event("u1"), type: "custom.unknown" },
        { knownTypes: new Set(["custom.unknown"]), now: () => 5 },
      );
      expect(replay.status).toBe("duplicate");
      expect(replay.eventId).toBe(r.eventId);
      expect(replay.rootId).toBeNull();
      expect(
        f.db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
      ).toBe(0);
    } finally {
      f.close();
    }
  });
});

for (const stage of [
  "event-altered",
  "delivery-created",
  "indexes-created",
  "before-schema-update",
]) {
  it(`rolls back Migration 7 after process termination at ${stage}`, async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-m7-kill-"));
    const legacy = join(home, "taskcircuit.db");
    const old = oldHub(legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const item = (
        await old.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.color", payload: {} },
        })
      ).json();
      await old.close();
      const path = await resolveCurrentStore(home);
      let db = new DatabaseSync(path);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        migrateDomain(db);
      } finally {
        db.close();
      }
      const oldHash = createHash("sha256")
        .update(readFileSync(legacy))
        .digest("hex");
      const child = fork(
        join(process.cwd(), "tests/fixtures/migration7-kill.mjs"),
        [path, stage],
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
            reject(new Error("migration exited before checkpoint"));
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
          ).toBe(6);
          expect(
            db
              .prepare("PRAGMA table_info(events)")
              .all()
              .some((r) => r.name === "schema_version"),
          ).toBe(false);
          expect(
            db
              .prepare(
                "SELECT name FROM sqlite_schema WHERE name='event_deliveries'",
              )
              .get(),
          ).toBeUndefined();
          migrateEventCore(db);
          expect(
            db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v,
          ).toBe(7);
          const legacyEvent = db
            .prepare("SELECT * FROM events WHERE id=?")
            .get(item.event.id);
          expect(legacyEvent?.schema_version).toBeNull();
          expect(
            db.prepare("SELECT COUNT(*) n FROM event_deliveries").get()?.n,
          ).toBe(0);
          expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          db.close();
        }
        expect(
          createHash("sha256").update(readFileSync(legacy)).digest("hex"),
        ).toBe(oldHash);
        expect(await resolveCurrentStore(home)).toBe(path);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    } finally {
      await old.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20000);
}

it("keeps delivery identity distinct from payload and source namespace", async () => {
  const f = await setup();
  try {
    const a = ingest(f.db, event("x"));
    const same = ingest(f.db, { ...event("x"), payload: { x: 1 } });
    expect(same.status).toBe("duplicate");
    const different = ingest(f.db, event("y"));
    expect(different.eventId).not.toBe(a.eventId);
    expect(different.rootId).toBe(a.rootId);
    const other = ingestEvent(
      f.db,
      { sourceInstance: "source-two", trustContext: "trusted_internal" },
      event("x"),
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    expect(other.eventId).not.toBe(a.eventId);
    expect(other.rootId).not.toBe(a.rootId);
    expect(() =>
      f.db.prepare("UPDATE events SET payload='{}' WHERE id=?").run(a.eventId),
    ).toThrow();
    expect(() =>
      f.db
        .prepare(
          "UPDATE event_deliveries SET source_event_id='changed' WHERE event_id=?",
        )
        .run(a.eventId),
    ).toThrow();
    expect(() =>
      f.db
        .prepare("DELETE FROM event_root_links WHERE event_id=?")
        .run(a.eventId),
    ).toThrow();
    expect(() =>
      f.db.prepare("DELETE FROM event_delivery_history").run(),
    ).toThrow();
    expect(() =>
      f.db
        .prepare("DELETE FROM event_deliveries WHERE event_id=?")
        .run(a.eventId),
    ).toThrow();
  } finally {
    f.close();
  }
});
it("authorizes parent inheritance only for trusted internal events", async () => {
  const f = await setup();
  try {
    const parent = ingest(f.db, event("p1"));
    const child = ingestEvent(
      f.db,
      { sourceInstance: "internal", trustContext: "trusted_internal" },
      { ...event("child"), parentEventId: parent.eventId },
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    expect(child.rootId).toBe(parent.rootId);
    expect(child.createdRoot).toBe(false);
    expect(() =>
      ingestEvent(
        f.db,
        { sourceInstance: "internal", trustContext: "trusted_internal" },
        { ...event("wrong-key", "other"), parentEventId: parent.eventId },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      ),
    ).toThrowError(expect.objectContaining({ code: "event_parent_invalid" }));
    const unknown = ingestEvent(
      f.db,
      { sourceInstance: "internal", trustContext: "trusted_internal" },
      {
        ...event("unknown-child"),
        type: "unknown.child",
        parentEventId: parent.eventId,
      },
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    expect(unknown.status).toBe("unroutable");
    expect(unknown.rootId).toBeNull();
    expect(() =>
      ingestEvent(
        f.db,
        { sourceInstance: "external", trustContext: "external_untrusted" },
        { ...event("bad"), parentEventId: parent.eventId },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      ),
    ).toThrowError(expect.objectContaining({ code: "event_parent_invalid" }));
    expect(() =>
      ingestEvent(
        f.db,
        { sourceInstance: "internal", trustContext: "trusted_internal" },
        { ...event("missing"), parentEventId: "missing" },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      ),
    ).toThrowError(expect.objectContaining({ code: "event_parent_invalid" }));
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(3);
  } finally {
    f.close();
  }
});
it("keeps payload control fields untrusted and returns stable API diagnostics", async () => {
  const f = await setup();
  f.db.close();
  const hub = createHub(
    f.path,
    defaultConfig,
    () => Date.parse("2026-01-01T00:00:00Z"),
    0,
    { dispatcherPollMs: 0 },
  );
  try {
    const post = (payload: unknown) =>
      hub.inject({ method: "POST", url: "/api/events/v2", payload });
    const payload = {
      agent: "privileged-agent",
      cwd: "C:\\",
      root_id: "another-root",
      budget: 999999,
      trust: "admin",
    };
    const first = await post({
      sourceEventId: "one",
      type: "demo.color",
      automationId: "automation-a",
      correlationKey: "a",
      sourceInstance: "forged",
      trustContext: "trusted_internal",
      payload,
    });
    expect(first.statusCode).toBe(200);
    const accepted = first.json();
    expect(accepted.status).toBe("accepted");
    expect(
      (
        await post({
          sourceEventId: "one",
          type: "demo.color",
          automationId: "automation-a",
          correlationKey: "a",
          payload,
        })
      ).json().status,
    ).toBe("duplicate");
    expect(
      (
        await post({
          sourceEventId: "one",
          type: "demo.color",
          automationId: "automation-a",
          correlationKey: "a",
          payload: { ...payload, budget: 1 },
        })
      ).statusCode,
    ).toBe(409);
    const detail = (
      await hub.inject(`/api/events/v2/${accepted.eventId}`)
    ).json();
    expect(
      (await hub.inject(`/api/events/${accepted.eventId}`)).statusCode,
    ).toBe(200);
    expect(detail.history.map((h: any) => h.state)).toEqual([
      "received",
      "validated",
      "deduplicated",
      "correlated",
      "routed",
      "processed",
      "duplicate",
    ]);
    expect(detail.event.payload).toEqual(payload);
    expect(detail.event.sourceInstance).toBe("local-cli");
    expect(detail.event.trustContext).toBe("trusted_local_cli");
    expect(accepted.rootId).not.toBe("another-root");
    expect(
      (
        await post({
          sourceEventId: "fake-parent",
          type: "demo.color",
          parentEventId: accepted.eventId,
          trustContext: "trusted_internal",
          payload: {},
        })
      ).json().error.code,
    ).toBe("event_parent_invalid");
    expect(
      (
        await post({
          sourceEventId: "secret",
          type: "demo.color",
          payload: { apiKey: "do-not-store" },
        })
      ).json().error.code,
    ).toBe("event_invalid");
    expect(
      (
        await post({
          sourceEventId: "nested-secret",
          type: "demo.color",
          payload: { nested: { access_token: "do-not-store" } },
        })
      ).json().error.code,
    ).toBe("event_invalid");
    expect(
      (
        await post({
          sourceEventId: "value-secret",
          type: "demo.color",
          payload: { text: "ghp_abcdefghijklmnopqrstuvwx" },
        })
      ).json().error.code,
    ).toBe("event_invalid");
    expect(
      (
        await post({
          sourceEventId: "large",
          type: "demo.color",
          payload: { x: "a".repeat(65537) },
        })
      ).json().error.code,
    ).toBe("event_too_large");
    const giant = await post({
      sourceEventId: "giant",
      type: "demo.color",
      payload: { x: "a".repeat(200000) },
    });
    expect(giant.statusCode).toBe(413);
    expect(giant.json().error.code).toBe("event_too_large");
    const unknown = await post({
      sourceEventId: "unknown",
      type: "unregistered.kind",
      automationId: "automation-a",
      payload: {},
    });
    expect(unknown.json().status).toBe("unroutable");
    expect(unknown.json().rootId).toBeNull();
    expect(
      (await hub.inject(`/api/roots/${accepted.rootId}/events`)).json(),
    ).toHaveLength(1);
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
it("accepts missing and skewed occurred times while using the local received clock", async () => {
  const f = await setup();
  try {
    for (const [id, occurredAt] of [
      ["past", "1900-01-01T00:00:00Z"],
      ["future", "2200-01-01T00:00:00Z"],
      ["none", undefined],
    ] as const) {
      const r = ingestEvent(
        f.db,
        source,
        { ...event(id), occurredAt },
        {
          knownTypes: new Set(["demo.color"]),
          now: () => Date.parse("2026-01-01T00:00:00Z"),
        },
      );
      expect(r.receivedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(
        f.db.prepare("SELECT occurred_at FROM events WHERE id=?").get(r.eventId)
          ?.occurred_at,
      ).toBe(occurredAt ?? null);
    }
  } finally {
    f.close();
  }
});

it("supports event CLI emit, show and list without changing legacy aliases", async () => {
  const f = await setup();
  f.db.close();
  const hub = createHub(f.path, defaultConfig, undefined, 0, {
    dispatcherPollMs: 0,
  });
  try {
    const base = await hub.listen({ host: "127.0.0.1", port: 0 });
    const run = promisify(execFile);
    const env = {
      ...process.env,
      TASKCIRCUIT_HOME: f.home,
      TASKCIRCUIT_PORT: new URL(base).port,
    };
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await run(process.execPath, ["dist/cli.js", ...args], {
            encoding: "utf8",
            env,
            windowsHide: true,
          })
        ).stdout,
      );
    const a = await cli(
      "event",
      "emit",
      "demo.color",
      "--source",
      "display-only",
      "--source-event-id",
      "cli-event",
      "--correlation-key",
      "cli-topic",
      "--automation",
      "automation-a",
      "--payload",
      '{"value":1}',
    );
    expect(a.status).toBe("accepted");
    const detail = await cli("event", "show", a.eventId);
    expect(detail.event.payload).toEqual({ value: 1 });
    expect(detail.event.sourceInstance).toBe("local-cli");
    expect(
      (await cli("event", "list")).some((e: any) => e.id === a.eventId),
    ).toBe(true);
    const legacy = await cli("work", "create", "demo.color", "--json");
    expect(legacy.workItem.rootId).toBeTruthy();
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
}, 20000);

for (const mode of ["same-delivery", "same-correlation"]) {
  it(`serializes concurrent processes with ${mode}`, async () => {
    const f = await setup();
    f.db.close();
    const ids =
      mode === "same-delivery" ? ["same", "same"] : ["first", "second"];
    const children = ids.map((id) =>
      fork(
        join(process.cwd(), "tests/fixtures/event-ingest-child.mjs"),
        [f.path, id, "shared"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    try {
      let ready = 0;
      const results = children.map(
        (child) =>
          new Promise<any>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("event race timeout")),
              10000,
            );
            child.on("message", (msg: any) => {
              if (msg === "ready") {
                ready++;
                if (ready === children.length)
                  for (const c of children) c.send("go");
              } else if (msg?.result) {
                clearTimeout(timer);
                resolve(msg.result);
              } else if (msg?.error) {
                clearTimeout(timer);
                reject(Error(msg.error));
              }
            });
            child.once("error", reject);
          }),
      );
      const values = await Promise.all(results);
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          await new Promise<void>((r) => child.once("exit", () => r()));
      expect(values[0].rootId).toBe(values[1].rootId);
      const db = new DatabaseSync(f.path, { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(
          mode === "same-delivery" ? 1 : 2,
        );
        expect(
          db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
        ).toBe(1);
        expect(db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
          0,
        );
        if (mode === "same-delivery")
          expect(values.map((v) => v.status).sort()).toEqual([
            "accepted",
            "duplicate",
          ]);
      } finally {
        db.close();
      }
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 20000);
}
it("recognizes duplicates after closing and reopening SQLite", async () => {
  const f = await setup();
  const a = ingest(f.db, event("restart"));
  f.db.close();
  try {
    const db = new DatabaseSync(f.path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      migrateEventCore(db);
      const b = ingest(db, event("restart"));
      expect(b.status).toBe("duplicate");
      expect(b.eventId).toBe(a.eventId);
      expect(b.rootId).toBe(a.rootId);
    } finally {
      db.close();
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});

for (const count of [1000, 10000]) {
  it(`persists ${count} sequential Events with indexed delivery identity`, async () => {
    const f = await setup();
    try {
      // Scale sanity tests application logic and indexes, not durable disk throughput.
      f.db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF");
      const opts = { knownTypes: new Set<string>(), now: () => 0 };
      for (let i = 0; i < count; i++)
        ingestEvent(
          f.db,
          source,
          {
            sourceEventId: `event-${i}`,
            type: "unregistered.type",
            payload: { i },
          },
          opts,
        );
      expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(
        count,
      );
      expect(
        f.db.prepare("SELECT COUNT(*) n FROM event_deliveries").get()?.n,
      ).toBe(count);
      expect(
        f.db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
      ).toBe(0);
      const plan = JSON.stringify(
        f.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM event_deliveries WHERE source_instance=? AND source_event_id=?",
          )
          .all("local-cli", "event-1"),
      );
      expect(plan).toMatch(/INDEX/i);
    } finally {
      f.close();
    }
  }, 120000);
}
it("handles 1000 duplicate submissions without new Events or Roots", async () => {
  const f = await setup();
  try {
    const first = ingest(f.db, event("repeat"));
    for (let i = 0; i < 1000; i++) {
      const next = ingest(f.db, event("repeat"));
      expect(next.eventId).toBe(first.eventId);
      expect(next.status).toBe("duplicate");
    }
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(1);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
    ).toBe(1);
  } finally {
    f.close();
  }
}, 120000);

it("chooses the most recently persisted terminal predecessor when clocks tie", async () => {
  const f = await setup();
  try {
    const insert = f.db.prepare(
      "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,subject_scope,subject_key,created_at,updated_at) VALUES(?,'automation-a',1,'automation','failed','local-cli','same','2026-01-01','2026-01-01')",
    );
    insert.run("z-older");
    insert.run("a-newer");
    const r = ingest(f.db, event("after", "same"));
    expect(r.predecessorRootId).toBe("a-newer");
  } finally {
    f.close();
  }
});

it("fails closed if SQLite foreign key enforcement is disabled", async () => {
  const f = await setup();
  try {
    f.db.exec("PRAGMA foreign_keys=OFF");
    expect(() => ingest(f.db, event("unsafe"))).toThrow();
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(0);
  } finally {
    f.close();
  }
});

it("refuses to reopen schema 7 if the correlation uniqueness index is missing", async () => {
  const f = await setup();
  try {
    f.db.exec("DROP INDEX active_correlation_root");
    expect(() => migrateEventCore(f.db)).toThrow();
  } finally {
    f.close();
  }
});

for (const stage of ["root-created", "event-inserted", "delivery-inserted"]) {
  it(`rolls back ingestion after process termination at ${stage}`, async () => {
    const f = await setup();
    f.db.close();
    const child = fork(
      join(process.cwd(), "tests/fixtures/event-ingest-kill.mjs"),
      [f.path, stage],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("ingest child timeout")),
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
          reject(Error("ingest child exited early"));
        });
      });
      const done = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await done;
      const db = new DatabaseSync(f.path);
      try {
        db.exec("PRAGMA foreign_keys=ON");
        for (const table of [
          "events",
          "event_deliveries",
          "automation_roots",
          "event_root_links",
        ])
          expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()?.n).toBe(
            0,
          );
        const replay = ingest(db, event("atomic", "atomic"));
        expect(replay.status).toBe("accepted");
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      rmSync(f.home, { recursive: true, force: true });
    }
  }, 20000);
}

it("links one logical Event to multiple trusted automation Roots", async () => {
  const f = await setup();
  try {
    createDefinition(f.db, "automation-b", "B", {}, "2026-01-01T00:00:00Z");
    const multi = {
      sourceEventId: "fanout",
      type: "demo.color",
      payload: { x: 1 },
      correlationKey: "subject",
      automationIds: ["automation-b", "automation-a"],
    };
    const options = { knownTypes: new Set(["demo.color"]), now: () => 0 };
    const accepted = ingestEvent(f.db, source, multi, options);
    expect(accepted.status).toBe("accepted");
    expect(
      f.db
        .prepare("SELECT COUNT(*) n FROM event_root_links WHERE event_id=?")
        .get(accepted.eventId)?.n,
    ).toBe(2);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
    ).toBe(2);
    f.db
      .prepare(
        "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,created_at,updated_at) VALUES('extra-root','automation-a',1,'automation','created','2026','2026')",
      )
      .run();
    expect(() =>
      f.db
        .prepare(
          "INSERT INTO event_root_links(event_id,root_id,relationship,created_at) VALUES(?,'extra-root','correlated','2026')",
        )
        .run(accepted.eventId),
    ).toThrow();
    const replay = ingestEvent(
      f.db,
      source,
      { ...multi, automationIds: ["automation-a", "automation-b"] },
      options,
    );
    expect(replay.status).toBe("duplicate");
    expect(replay.eventId).toBe(accepted.eventId);
    expect(replay.roots).toEqual(accepted.roots);
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(0);
    const rootA = String(
      f.db
        .prepare(
          "SELECT id FROM automation_roots WHERE definition_id='automation-a' AND id<>'extra-root'",
        )
        .get()?.id,
    );
    const child = {
      sourceEventId: "child-fanout",
      type: "demo.color",
      payload: { x: 2 },
      automationId: "automation-a",
      correlationKey: "subject",
      parentEventId: accepted.eventId,
    };
    expect(() =>
      ingestEvent(
        f.db,
        { sourceInstance: "internal", trustContext: "trusted_internal" },
        child,
        options,
      ),
    ).toThrowError(expect.objectContaining({ code: "event_parent_invalid" }));
    const inherited = ingestEvent(
      f.db,
      {
        sourceInstance: "internal",
        trustContext: "trusted_internal",
        originRootId: rootA,
      },
      child,
      options,
    );
    expect(inherited.rootId).toBe(rootA);
    const inconsistent = ingestEvent(
      f.db,
      {
        sourceInstance: "internal",
        trustContext: "trusted_internal",
        originRootId: "extra-root",
      },
      child,
      options,
    );
    expect(inconsistent.status).toBe("conflict");
  } finally {
    f.close();
  }
});

it("uses canonical JSON rather than object insertion order for delivery equality", async () => {
  const f = await setup();
  try {
    const a = ingestEvent(
      f.db,
      source,
      { ...event("canonical"), payload: { a: 1, b: { x: 2, y: 3 } } },
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    const b = ingestEvent(
      f.db,
      source,
      { ...event("canonical"), payload: { b: { y: 3, x: 2 }, a: 1 } },
      { knownTypes: new Set(["demo.color"]), now: () => 10 },
    );
    expect(b.status).toBe("duplicate");
    expect(b.eventId).toBe(a.eventId);
  } finally {
    f.close();
  }
});
it("rejects invalid trusted routing metadata without creating an Event or Root", async () => {
  const f = await setup();
  try {
    expect(() =>
      ingest(f.db, { ...event("bad-auto"), automationId: "missing" }),
    ).toThrowError(
      expect.objectContaining({ code: "event_automation_not_found" }),
    );
    expect(() =>
      ingest(f.db, { ...event("bad-system"), automationId: "system/manual" }),
    ).toThrowError(
      expect.objectContaining({ code: "event_automation_not_found" }),
    );
    expect(() =>
      ingest(f.db, {
        ...event("bad-key"),
        correlationKey: "ghp_abcdefghijklmnopqrstuvwx",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "event_correlation_invalid" }),
    );
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(0);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM automation_roots").get()?.n,
    ).toBe(0);
  } finally {
    f.close();
  }
});

it("paginates Root event history in durable insertion order", async () => {
  const f = await setup();
  let root = "";
  try {
    // This connection only seeds pagination; recovery tests keep durable writes.
    f.db.exec("PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF");
    for (let i = 0; i < 101; i++) {
      const result = ingest(f.db, event(`page-${i}`));
      root = result.rootId!;
    }
    f.db.close();
    const hub = createHub(f.path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const first = (await hub.inject(`/api/roots/${root}/events`)).json();
      expect(first).toHaveLength(100);
      expect(first[0]).not.toHaveProperty("payload");
      const second = (
        await hub.inject(
          `/api/roots/${root}/events?after=${first.at(-1).sequence}`,
        )
      ).json();
      expect(second).toHaveLength(1);
      expect(second[0].sequence).toBeGreaterThan(first.at(-1).sequence);
      expect(
        (await hub.inject(`/api/roots/${root}/events?after=bad`)).statusCode,
      ).toBe(400);
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
  // Gives CI scheduling/platform margin; pagination performance is not being benchmarked.
}, 15000);

it("rejects non-loopback callers rather than labeling them trusted local", async () => {
  const f = await setup();
  f.db.close();
  const hub = createHub(f.path, defaultConfig, undefined, 0, {
    dispatcherPollMs: 0,
  });
  try {
    const response = await hub.inject({
      method: "POST",
      url: "/api/events/v2",
      remoteAddress: "203.0.113.1",
      payload: {
        sourceEventId: "remote",
        type: "demo.color",
        automationId: "automation-a",
        payload: {},
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("event_source_invalid");
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});

it("rejects malformed identity and type and enforces the UTF-8 payload boundary", async () => {
  const f = await setup();
  try {
    const opts = { knownTypes: new Set<string>(), now: () => 0 };
    for (const bad of [
      { sourceEventId: "", type: "a", payload: {} },
      { sourceEventId: "id", type: "../escape", payload: {} },
      { sourceEventId: "id", type: "a", payload: undefined },
    ])
      expect(() => ingestEvent(f.db, source, bad, opts)).toThrowError(
        expect.objectContaining({ code: "event_invalid" }),
      );
    const exact = ingestEvent(
      f.db,
      source,
      { sourceEventId: "exact", type: "a", payload: "x".repeat(65534) },
      opts,
    );
    expect(exact.status).toBe("unroutable");
    expect(() =>
      ingestEvent(
        f.db,
        source,
        { sourceEventId: "over", type: "a", payload: "x".repeat(65535) },
        opts,
      ),
    ).toThrowError(expect.objectContaining({ code: "event_too_large" }));
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()?.n).toBe(1);
  } finally {
    f.close();
  }
});
