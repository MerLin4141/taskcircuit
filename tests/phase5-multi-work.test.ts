// Guards one active Agent per Root and durable deferred continuation across multiple Work Items.
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { createHub } from "../src/hub.js";
import { migrateDomain, createDefinition } from "../src/automation-domain.js";
import { migrateEventCore, ingestEvent } from "../src/event-core.js";
import { migrateDecisionCore, evaluateDecision } from "../src/decision-core.js";
import { migrateMaterialization } from "../src/decision-materialization.js";
import { migrateLoopLimits } from "../src/loop-limits.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
it("serializes two Work Items and preserves the deferred continuation", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-p5-multi-"));
  const oldHome = process.env.TASKCIRCUIT_HOME;
  process.env.TASKCIRCUIT_HOME = join(home, "state");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const config = {
    ...defaultConfig,
    policyWorkspaces: {
      safe: {
        path: workspace,
        allowedRoot: home,
        allowedCapabilities: ["read_files"],
      },
    },
  };
  const path = await resolveCurrentStore(home);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  migrateDomain(db);
  migrateEventCore(db);
  migrateDecisionCore(db);
  migrateMaterialization(db);
  migrateLoopLimits(db);
  const clock = () => Date.parse("2026-01-01T00:00:00Z");
  createDefinition(
    db,
    "a",
    "Auto",
    {
      loop: { maxRuns: 3, maxDurationSeconds: 120 },
      policy: {
        effect: "authorize",
        eventTypes: ["demo.color"],
        agentProfileId: "demo-agent",
        agentProfileSnapshot: defaultConfig.agents["demo-agent"],
        workspaceId: "safe",
        workspacePath: workspace,
        workspaceAllowedRoot: home,
        allowedCapabilities: ["read_files"],
        requestedCapabilities: ["read_files"],
        requiresApproval: false,
      },
    },
    "2026-01-01T00:00:00Z",
  );
  let rootId = "";
  for (let i = 1; i <= 2; i++) {
    const e = ingestEvent(
      db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: `event-${i}`,
        type: "demo.color",
        automationId: "a",
        correlationKey: "subject",
        payload: {},
      },
      { knownTypes: new Set(["demo.color"]), now: clock },
    );
    rootId = e.rootId!;
    evaluateDecision(
      db,
      { requestId: `request-${i}`, eventId: e.eventId, rootId, generation: 1 },
      { config, now: clock },
    );
  }
  const hub = createHub(path, config, clock, 0, { dispatcherPollMs: 0 });
  let release!: () => void, notify!: () => void;
  const started = new Promise<void>((r) => (notify = r));
  const unblock = new Promise<void>((r) => (release = r));
  try {
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM work_items WHERE root_id=?")
        .get(rootId)?.n,
    ).toBe(2);
    let firstWork = "",
      calls = 0;
    const adapter = {
      async execute(input: any) {
        calls++;
        if (!firstWork) {
          firstWork = input.workItemId;
          notify();
          await unblock;
          return {
            type: "continue" as const,
            sessionId: "fake-a",
            message: "next",
          };
        }
        if (input.workItemId === firstWork)
          return {
            type: "completed" as const,
            sessionId: "fake-a",
            output: "done",
          };
        return {
          type: "completed" as const,
          sessionId: "fake-b",
          output: "done",
        };
      },
    };
    const running = workOnce(base, "worker-a", adapter);
    await started;
    expect(await workOnce(base, "worker-b", adapter)).toBe(false);
    release();
    expect(await running).toBe(true);
    expect(await workOnce(base, "worker-b", adapter)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM executions WHERE trigger_kind='continue'",
        )
        .get()?.n,
    ).toBe(0);
    expect(await workOnce(base, "worker-c", adapter)).toBe(true);
    expect(calls).toBe(3);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM executions WHERE trigger_kind='continue'",
        )
        .get()?.n,
    ).toBe(1);
    expect(
      db.prepare("SELECT status FROM automation_roots WHERE id=?").get(rootId)
        ?.status,
    ).toBe("completed");
  } finally {
    release();
    db.close();
    await hub.close();
    if (oldHome === undefined) delete process.env.TASKCIRCUIT_HOME;
    else process.env.TASKCIRCUIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

it("two processes competing for the last Root run create one successor and preserve the other", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-p5-last-slot-"));
  const oldHome = process.env.TASKCIRCUIT_HOME;
  process.env.TASKCIRCUIT_HOME = join(home, "state");
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const config = {
    ...defaultConfig,
    policyWorkspaces: {
      safe: {
        path: workspace,
        allowedRoot: home,
        allowedCapabilities: ["read_files"],
      },
    },
  };
  const path = await resolveCurrentStore(home);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  migrateDomain(db);
  migrateEventCore(db);
  migrateDecisionCore(db);
  migrateMaterialization(db);
  migrateLoopLimits(db);
  const clock = () => Date.parse("2026-01-01T00:00:00Z");
  createDefinition(
    db,
    "a",
    "Auto",
    {
      loop: { maxRuns: 3, maxDurationSeconds: 120 },
      policy: {
        effect: "authorize",
        eventTypes: ["demo.color"],
        agentProfileId: "demo-agent",
        agentProfileSnapshot: defaultConfig.agents["demo-agent"],
        workspaceId: "safe",
        workspacePath: workspace,
        workspaceAllowedRoot: home,
        allowedCapabilities: ["read_files"],
        requestedCapabilities: ["read_files"],
        requiresApproval: false,
      },
    },
    "2026-01-01T00:00:00Z",
  );
  let rootId = "";
  for (let i = 1; i <= 2; i++) {
    const e = ingestEvent(
      db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: `event-${i}`,
        type: "demo.color",
        automationId: "a",
        correlationKey: "subject",
        payload: {},
      },
      { knownTypes: new Set(["demo.color"]), now: clock },
    );
    rootId = e.rootId!;
    evaluateDecision(
      db,
      { requestId: `request-${i}`, eventId: e.eventId, rootId, generation: 1 },
      { config, now: clock },
    );
  }
  const hub = createHub(path, config, clock, 0, { dispatcherPollMs: 0 });
  try {
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    let calls = 0;
    const adapter = {
      async execute() {
        calls++;
        return {
          type: "continue" as const,
          sessionId: `session-${calls}`,
          message: "next",
        };
      },
    };
    expect(await workOnce(base, "worker-a", adapter)).toBe(true);
    expect(await workOnce(base, "worker-b", adapter)).toBe(true);
    const parents = db
      .prepare("SELECT id FROM executions WHERE status='completed' ORDER BY id")
      .all();
    expect(parents).toHaveLength(2);
    const file = join(home, "config.json");
    writeFileSync(file, JSON.stringify(config));
    const children = parents.map((p) =>
      fork(
        join(process.cwd(), "tests/fixtures/phase5-continuation-race.mjs"),
        [path, file, String(p.id), "2026-01-01T00:00:00.000Z"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    try {
      const results = await Promise.all(
        children.map(
          (c) =>
            new Promise<any>((resolve, reject) => {
              const timer = setTimeout(() => reject(Error("timeout")), 10000);
              c.on("message", (m) => {
                if (m === "ready") c.send("go");
                else {
                  clearTimeout(timer);
                  resolve(m);
                }
              });
              c.once("error", reject);
            }),
        ),
      );
      expect(results.every((x) => x.result)).toBe(true);
      expect(db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(3);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM executions WHERE trigger_kind='continue'",
          )
          .get()?.n,
      ).toBe(1);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM work_items WHERE status='waiting_schedule'",
          )
          .get()?.n,
      ).toBe(1);
    } finally {
      for (const c of children) if (c.exitCode === null && !c.killed) c.kill();
    }
  } finally {
    db.close();
    await hub.close();
    if (oldHome === undefined) delete process.env.TASKCIRCUIT_HOME;
    else process.env.TASKCIRCUIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
