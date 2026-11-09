// A retired TaskCircuit build must never submit new work after generation cutover.
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  existsSync,
  rmSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { resultDigest } from "../src/result-receipt.js";
import { createHub as oldHub } from "./fixtures/v012-runtime/hub.js";
import { workOnce as oldWorkOnce } from "./fixtures/v012-runtime/worker.js";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "./fixtures/v012-runtime/config.js";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { migrate } from "../src/migration.js";

function temp() {
  const root = mkdtempSync(join(tmpdir(), "tc-generation-test-"));
  return {
    root,
    legacy: join(root, "taskcircuit.db"),
    current: join(root, "taskcircuit-gen2.db"),
  };
}
const post = (h: any, url: string, payload: unknown) =>
  h.inject({ method: "POST", url, payload });
describe("storage generation isolation", () => {
  it("separates a real v0.1.2 database and persistently denies old writes", async () => {
    const f = temp();
    let old = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      expect(
        (
          await post(old, "/api/events", {
            source: "local",
            type: "demo.color",
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      await old.close();
      expect(await resolveCurrentStore(f.root)).toBe(f.current);
      old = oldHub(f.legacy, defaultConfig, undefined, 0, {
        dispatcherPollMs: 0,
      });
      expect((await old.inject("/api/work-items")).statusCode).toBe(200);
      expect(
        (
          await post(old, "/api/events", {
            source: "local",
            type: "demo.color",
            payload: {},
          })
        ).statusCode,
      ).not.toBe(200);
      expect(
        (await post(old, "/api/executions/claim", { workerId: "old" }))
          .statusCode,
      ).not.toBe(200);
      const db = new DatabaseSync(f.current, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()!
            .v,
        ).toBe(5);
      } finally {
        db.close();
      }
    } finally {
      await old.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("rejects active legacy execution rather than copying it", async () => {
    const f = temp();
    const h = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await post(h, "/api/events", {
        source: "local",
        type: "demo.color",
        payload: {},
      });
      expect(
        (await post(h, "/api/executions/claim", { workerId: "active" }))
          .statusCode,
      ).toBe(200);
      await h.close();
      await expect(resolveCurrentStore(f.root)).rejects.toMatchObject({
        code: "storage_legacy_execution_active",
      });
      expect(existsSync(f.current)).toBe(false);
    } finally {
      await h.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  for (const checkpoint of [
    "barrier-acquired",
    "backup-created",
    "generation-transaction-open",
    "generation-prepared",
    "legacy-committed",
    "generation-promoted",
  ]) {
    it(`recovers after process termination at ${checkpoint}`, async () => {
      const f = temp();
      const old = oldHub(f.legacy, defaultConfig, undefined, 0, {
        dispatcherPollMs: 0,
      });
      try {
        expect(
          (
            await post(old, "/api/events", {
              source: "local",
              type: "demo.color",
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await old.close();
      }
      const c = fork(
        join(process.cwd(), "tests/fixtures/cutover-child.mjs"),
        [f.root, checkpoint],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("checkpoint timeout")),
            10000,
          );
          c.on("message", (m: any) => {
            if (m.stage === checkpoint) {
              clearTimeout(timer);
              resolve();
            } else if (m.stage === "unexpected-complete") {
              clearTimeout(timer);
              reject(new Error("checkpoint missed"));
            }
          });
          c.once("exit", (code) => {
            if (code !== null && code !== 0) {
              clearTimeout(timer);
              reject(new Error(`child exit ${code}`));
            }
          });
        });
        const exited = new Promise<void>((r) => c.once("exit", () => r()));
        c.kill("SIGKILL");
        await exited;
        const db = new DatabaseSync(f.legacy, { readOnly: true });
        let marked = false;
        try {
          marked = !!db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name='taskcircuit_storage_cutover'",
            )
            .get();
        } finally {
          db.close();
        }
        const committed =
          checkpoint === "legacy-committed" ||
          checkpoint === "generation-promoted";
        expect(marked).toBe(committed);
        if (!committed) expect(existsSync(f.current)).toBe(false);
        expect(await resolveCurrentStore(f.root)).toBe(f.current);
        const current = new DatabaseSync(f.current, { readOnly: true });
        try {
          expect(
            current.prepare("SELECT COUNT(*) n FROM work_items").get()!.n,
          ).toBe(1);
        } finally {
          current.close();
        }
      } finally {
        if (c.exitCode === null && c.signalCode === null) c.kill();
        rmSync(f.root, { recursive: true, force: true });
      }
    }, 20000);
  }
  it("rebuilds a missing pending generation from the checked backup after quarantine", async () => {
    const f = temp();
    const old = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    await old.close();
    const c = fork(
      join(process.cwd(), "tests/fixtures/cutover-child.mjs"),
      [f.root, "legacy-committed"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("timeout")), 10000);
        c.on("message", (m: any) => {
          if (m.stage === "legacy-committed") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const exited = new Promise<void>((r) => c.once("exit", () => r()));
      c.kill("SIGKILL");
      await exited;
      const pending = readdirSync(f.root).filter((x) => x.endsWith(".tmp.db"));
      expect(pending).toHaveLength(1);
      unlinkSync(join(f.root, pending[0]));
      expect(await resolveCurrentStore(f.root)).toBe(f.current);
    } finally {
      if (c.exitCode === null && c.signalCode === null) c.kill();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
  it("rebuilds a corrupt pending generation from the checked backup after quarantine", async () => {
    const f = temp();
    const old = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    await old.close();
    const c = fork(
      join(process.cwd(), "tests/fixtures/cutover-child.mjs"),
      [f.root, "legacy-committed"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("timeout")), 10000);
        c.on("message", (m: any) => {
          if (m.stage === "legacy-committed") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      const exited = new Promise<void>((r) => c.once("exit", () => r()));
      c.kill("SIGKILL");
      await exited;
      const pending = readdirSync(f.root).filter((x) => x.endsWith(".tmp.db"));
      expect(pending).toHaveLength(1);
      writeFileSync(join(f.root, pending[0]), "corrupt incomplete database");
      expect(await resolveCurrentStore(f.root)).toBe(f.current);
    } finally {
      if (c.exitCode === null && c.signalCode === null) c.kill();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
  it("preserves every legacy table row in the new generation", async () => {
    const f = temp();
    const old = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await post(old, "/api/events", {
        source: "local",
        type: "demo.color",
        payload: {},
      });
      const claim = (
        await post(old, "/api/executions/claim", { workerId: "seed" })
      ).json();
      const result = {
        type: "needs_input",
        sessionId: "preserved-session",
        request: { title: "q", text: "q", key: "k", options: ["yes"] },
      };
      const submissionId = randomUUID();
      expect(
        (
          await post(old, `/api/executions/${claim.execution.id}/result`, {
            workerId: "seed",
            leaseToken: claim.leaseToken,
            submissionId,
            resultDigest: resultDigest(result),
            result,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(old, "/api/schedules", {
            kind: "once",
            runAt: "2030-01-01T00:00:00.000Z",
            event: { source: "local", type: "demo.color", payload: {} },
          })
        ).statusCode,
      ).toBe(200);
      await old.close();
      const before = new DatabaseSync(f.legacy, { readOnly: true });
      const tables = before
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map((r: any) => r.name as string);
      const rows = new Map(
        tables.map((name: string) => [
          name,
          before.prepare(`SELECT * FROM "${name}"`).all(),
        ]),
      );
      before.close();
      await resolveCurrentStore(f.root);
      const after = new DatabaseSync(f.current, { readOnly: true });
      try {
        for (const name of tables) {
          const condition =
            name === "schema_migrations" ? " WHERE version <= 4" : "";
          expect(
            after.prepare(`SELECT * FROM "${name}"${condition}`).all(),
          ).toEqual(rows.get(name));
        }
      } finally {
        after.close();
      }
    } finally {
      await old.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("rejects a future schema even via the direct migration entry point", () => {
    const f = temp();
    const db = new DatabaseSync(f.legacy);
    try {
      migrate(db);
      db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(
        new Date().toISOString(),
      );
      expect(() => migrate(db)).toThrowError(
        expect.objectContaining({ code: "database_schema_too_new" }),
      );
    } finally {
      db.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("rejects schema versions newer than the supported generation", async () => {
    const f = temp();
    try {
      await resolveCurrentStore(f.root);
      const db = new DatabaseSync(f.current);
      try {
        db.prepare("INSERT INTO schema_migrations VALUES(11,?)").run(
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
      await expect(resolveCurrentStore(f.root)).rejects.toMatchObject({
        code: "database_schema_too_new",
      });
      const cli = spawnSync(process.execPath, ["dist/cli.js", "hub"], {
        encoding: "utf8",
        env: { ...process.env, TASKCIRCUIT_HOME: f.root },
      });
      expect(cli.status).not.toBe(0);
      expect(cli.stderr).toContain("database_schema_too_new");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("serializes two simultaneous migration attempts without leaving stale process locks", async () => {
    const f = temp();
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (acquired = r));
    try {
      const first = resolveCurrentStore(f.root, {
        onStage: async (s) => {
          if (s === "barrier-acquired") {
            acquired();
            await held;
          }
        },
      });
      await ready;
      await expect(resolveCurrentStore(f.root)).rejects.toMatchObject({
        code: "storage_migration_busy",
      });
      release();
      expect(await first).toBe(f.current);
      expect(await resolveCurrentStore(f.root)).toBe(f.current);
    } finally {
      release?.();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("the genuine v0.1.2 Hub accepts a simulated future schema marker", async () => {
    const f = temp();
    let h = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await post(h, "/api/events", {
        source: "local",
        type: "demo.color",
        payload: {},
      });
      await h.close();
      const db = new DatabaseSync(f.legacy);
      try {
        expect(
          db.prepare("SELECT MAX(version) v FROM schema_migrations").get()!.v,
        ).toBe(4);
        db.prepare("INSERT INTO schema_migrations VALUES(5,?)").run(
          new Date().toISOString(),
        );
      } finally {
        db.close();
      }
      h = oldHub(f.legacy, defaultConfig, undefined, 0, {
        dispatcherPollMs: 0,
      });
      expect(
        (await post(h, "/api/executions/claim", { workerId: "old" }))
          .statusCode,
      ).toBe(200);
    } finally {
      await h.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("quarantines legacy mutations and old worker invocation while Generation 2 remains usable", async () => {
    const f = temp();
    let now = Date.parse("2026-11-09T00:00:00Z");
    let old = oldHub(f.legacy, defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    let current: ReturnType<typeof createHub> | undefined;
    let calls = 0;
    try {
      const q = (
        await post(old, "/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json();
      const claim = (
        await post(old, "/api/executions/claim", { workerId: "seed" })
      ).json();
      expect(
        (
          await post(old, `/api/executions/${claim.execution.id}/result`, {
            workerId: "seed",
            leaseToken: claim.leaseToken,
            result: {
              type: "needs_input",
              sessionId: "fixture-session",
              request: { title: "q", text: "q", key: "k", options: ["yes"] },
            },
          })
        ).statusCode,
      ).toBe(200);
      const oldState = (
        await old.inject(`/api/work-items/${q.workItem.id}`)
      ).json();
      const interaction = oldState.interactions[0].id;
      await post(old, "/api/events", {
        source: "local",
        type: "demo.color",
        payload: {},
      });
      await post(old, "/api/schedules", {
        kind: "once",
        runAt: new Date(now).toISOString(),
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      await old.close();
      await resolveCurrentStore(f.root);
      old = oldHub(f.legacy, defaultConfig, () => now, 0, {
        dispatcherPollMs: 0,
      });
      const base = await old.listen({ host: "127.0.0.1", port: 0 });
      expect((await old.inject("/api/work-items")).statusCode).toBe(200);
      expect(
        (
          await post(old, "/api/events", {
            source: "local",
            type: "demo.cron",
            payload: {},
          })
        ).statusCode,
      ).toBe(500);
      expect(
        (
          await post(old, `/api/interactions/${interaction}/answer`, {
            answer: "yes",
          })
        ).statusCode,
      ).toBe(500);
      for (const staleResult of [
        {
          type: "later",
          sessionId: "fixture-session",
          afterSeconds: 1,
          message: "later",
        },
        {
          type: "failed",
          error: {
            code: "agent_execution",
            message: "retry",
            retryable: true,
            safeToRetry: true,
          },
        },
      ]) {
        expect(
          (
            await post(old, `/api/executions/${claim.execution.id}/result`, {
              workerId: "seed",
              leaseToken: claim.leaseToken,
              result: staleResult,
            })
          ).statusCode,
        ).not.toBe(200);
      }
      expect(
        (
          await post(old, "/api/schedules", {
            kind: "once",
            runAt: "2030-01-01T00:00:00.000Z",
            event: { source: "local", type: "demo.cron", payload: {} },
          })
        ).statusCode,
      ).not.toBe(200);
      expect(() => old.tickScheduler()).toThrow(
        /taskcircuit_database_upgraded/,
      );
      await expect(
        oldWorkOnce(base, "old-fake", {
          execute: async () => {
            calls++;
            return {
              type: "completed",
              sessionId: "fake",
              output: "unexpected",
            };
          },
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      const legacy = new DatabaseSync(f.legacy, { readOnly: true });
      try {
        const tables = legacy
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all();
        const n = legacy
          .prepare(
            "SELECT COUNT(*) n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'taskcircuit_quarantine_%'",
          )
          .get()!.n;
        expect(n).toBe(tables.length * 3);
      } finally {
        legacy.close();
      }
      current = createHub(f.current, defaultConfig, () => now, 0, {
        dispatcherPollMs: 0,
      });
      const before = (await current.inject("/api/work-items")).json().length;
      expect(
        (
          await post(current, "/api/events", {
            source: "local",
            type: "demo.cron",
            payload: {},
          })
        ).statusCode,
      ).toBe(200);
      const after = (await current.inject("/api/work-items")).json().length;
      expect(after).toBe(before + 1);
      expect(
        (
          await post(old, "/api/events", {
            source: "local",
            type: "demo.color",
            payload: {},
          })
        ).statusCode,
      ).toBe(500);
      expect((await current.inject("/api/work-items")).json()).toHaveLength(
        after,
      );
    } finally {
      if (current) await current.close();
      await old.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("rejects a legacy unknown outcome even when its lease is no longer running", async () => {
    const f = temp();
    const h = oldHub(f.legacy, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const created = (
        await post(h, "/api/events", {
          source: "local",
          type: "demo.color",
          payload: {},
        })
      ).json();
      await h.close();
      const db = new DatabaseSync(f.legacy);
      try {
        db.prepare(
          "UPDATE executions SET status='failed',error=? WHERE work_item_id=?",
        ).run(
          JSON.stringify({ code: "execution_outcome_unknown" }),
          created.workItem.id,
        );
      } finally {
        db.close();
      }
      await expect(resolveCurrentStore(f.root)).rejects.toMatchObject({
        code: "storage_legacy_execution_active",
      });
      expect(existsSync(f.current)).toBe(false);
    } finally {
      await h.close();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
  it("holds a writer barrier against actual old Worker and Scheduler before persistent quarantine", async () => {
    const f = temp();
    const time = Date.parse("2026-11-09T00:00:00Z");
    const children: ChildProcess[] = [];
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const ready = new Promise<void>((r) => (acquired = r));
    let migration: Promise<string> | undefined;
    type Message = { type: string; base?: string; marker?: boolean };
    const launch = (file: string, args: string[]) => {
      const child = fork(join(process.cwd(), "tests/fixtures", file), args, {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, TASKCIRCUIT_HOME: f.root },
      });
      const messages: Message[] = [];
      child.on("message", (m) => messages.push(m as Message));
      children.push(child);
      return { child, messages };
    };
    const until = async (check: () => boolean) => {
      const end = Date.now() + 10000;
      while (!check()) {
        if (Date.now() > end) throw Error("controlled process timeout");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const send = async (base: string, path: string, payload: unknown) =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    try {
      const a = launch("cutover-old-hub.mjs", [f.legacy, String(time)]);
      await until(() => a.messages.some((m) => m.type === "ready"));
      const abase = a.messages.find((m) => m.type === "ready")!.base!;
      const b = launch("cutover-old-hub.mjs", [f.legacy, String(time)]);
      await until(() => b.messages.some((m) => m.type === "ready"));
      expect(
        (
          await send(abase, "/api/events", {
            source: "local",
            type: "demo.color",
            payload: {},
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await send(abase, "/api/schedules", {
            kind: "once",
            runAt: new Date(time).toISOString(),
            event: { source: "local", type: "demo.cron", payload: {} },
          })
        ).status,
      ).toBe(200);
      migration = resolveCurrentStore(f.root, {
        onStage: async (stage) => {
          if (stage === "barrier-acquired") {
            acquired();
            await held;
          }
        },
      });
      await ready;
      const worker = launch("cutover-old-worker.mjs", [abase]);
      await until(() =>
        worker.messages.some((m) => m.type === "claim-request"),
      );
      b.child.send("tick");
      await until(() => b.messages.some((m) => m.type === "tick-start"));
      await new Promise((r) => setTimeout(r, 250));
      expect(
        worker.messages.some(
          (m) =>
            m.type === "agent-called" ||
            m.type === "worker-return" ||
            m.type === "worker-error",
        ),
      ).toBe(false);
      expect(
        b.messages.some(
          (m) => m.type === "tick-end" || m.type === "tick-error",
        ),
      ).toBe(false);
      release();
      expect(await migration).toBe(f.current);
      await until(() =>
        worker.messages.some(
          (m) => m.type === "worker-error" || m.type === "worker-return",
        ),
      );
      await until(() =>
        b.messages.some(
          (m) => m.type === "tick-error" || m.type === "tick-end",
        ),
      );
      expect(worker.messages.some((m) => m.type === "agent-called")).toBe(
        false,
      );
      expect(worker.messages.some((m) => m.type === "worker-error")).toBe(true);
      expect(b.messages.find((m) => m.type === "tick-error")?.marker).toBe(
        true,
      );
    } finally {
      release?.();
      if (migration) await migration.catch(() => {});
      for (const c of children) if (c.connected) c.send("stop", () => {});
      for (const c of children)
        if (c.exitCode === null && c.signalCode === null)
          await new Promise<void>((r) => {
            c.once("exit", () => r());
            setTimeout(() => {
              if (c.exitCode === null && c.signalCode === null) c.kill();
              r();
            }, 2000);
          });
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
  it("prevents concurrent migration across processes and recovers after the lock owner dies", async () => {
    const f = temp();
    const script = join(process.cwd(), "tests/fixtures/cutover-child.mjs");
    const a = fork(script, [f.root, "barrier-acquired"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let b: ChildProcess | undefined;
    const awaitMessage = (c: ChildProcess, stage: string) =>
      new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("child timeout")), 10000);
        c.on("message", (m: any) => {
          if (m.stage === stage) {
            clearTimeout(timer);
            resolve(m);
          }
        });
        c.once("error", reject);
      });
    try {
      await awaitMessage(a, "barrier-acquired");
      b = fork(script, [f.root, "unused"], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const result = await awaitMessage(b, "error");
      expect(result.code).toBe("storage_migration_busy");
      const exited = new Promise<void>((r) => a.once("exit", () => r()));
      a.kill("SIGKILL");
      await exited;
      expect(await resolveCurrentStore(f.root)).toBe(f.current);
    } finally {
      if (a.exitCode === null && a.signalCode === null) a.kill();
      if (b && b.exitCode === null && b.signalCode === null) b.kill();
      rmSync(f.root, { recursive: true, force: true });
    }
  }, 20000);
});
