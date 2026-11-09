// Guards durable per-Root decisions, replay identity and the no-execution boundary.
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../src/storage/generation.js";
import {
  migrateDomain,
  createDefinition,
  addDefinitionVersion,
} from "../src/automation-domain.js";
import { migrateEventCore, ingestEvent } from "../src/event-core.js";
import {
  migrateDecisionCore,
  evaluateDecision,
  processPendingDecisions,
  getDecision,
} from "../src/decision-core.js";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "tc-decision-"));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const path = await resolveCurrentStore(home);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  migrateDomain(db);
  migrateEventCore(db);
  migrateDecisionCore(db);
  const agent = defaultConfig.agents["demo-agent"];
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
  const snapshot = {
    policy: {
      effect: "authorize",
      eventTypes: ["demo.color"],
      agentProfileId: "demo-agent",
      agentProfileSnapshot: agent,
      workspaceId: "safe",
      workspacePath: workspace,
      workspaceAllowedRoot: home,
      allowedCapabilities: ["read_files"],
      requestedCapabilities: ["read_files"],
      requiresApproval: false,
    },
  };
  createDefinition(db, "auto", "Auto", snapshot, "2026-01-01T00:00:00Z");
  const ev = ingestEvent(
    db,
    { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
    {
      sourceEventId: "evt1",
      type: "demo.color",
      payload: { cwd: "evil", agent: "admin", capabilities: ["shell"] },
      automationId: "auto",
      correlationKey: "one",
    },
    { knownTypes: new Set(["demo.color"]), now: () => 0 },
  );
  return {
    home,
    path,
    workspace,
    db,
    config,
    ev,
    close() {
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
it("commits one immutable authorized intent and replays the same request", async () => {
  const f = await setup();
  try {
    const request = {
      requestId: "request-1",
      eventId: f.ev.eventId,
      rootId: f.ev.rootId!,
      generation: 1,
    };
    const a = evaluateDecision(f.db, request, {
      config: f.config,
      now: () => 0,
    });
    const b = evaluateDecision(f.db, request, {
      config: f.config,
      now: () => 1,
    });
    expect(a.status).toBe("created");
    expect(b.status).toBe("duplicate");
    expect(a.decision.id).toBe(b.decision.id);
    expect(a.decision.type).toBe("authorize_execution");
    expect(a.decision.plan.agentProfileId).toBe("demo-agent");
    expect(a.decision.plan.workspaceId).toBe("safe");
    expect(a.decision.plan.capabilities).toEqual(["read_files"]);
    expect(a.decision.plan.workItem).toEqual({ kind: "create_work_item" });
    expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(0);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(0);
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId!)?.status,
    ).toBe("created");
    expect(() =>
      f.db
        .prepare("UPDATE decisions SET reason_code='changed' WHERE id=?")
        .run(a.decision.id),
    ).toThrow();
    expect(() =>
      evaluateDecision(
        f.db,
        { ...request, rootId: "other-root" },
        { config: f.config, now: () => 2 },
      ),
    ).toThrowError(
      expect.objectContaining({ code: "decision_request_conflict" }),
    );
  } finally {
    f.close();
  }
});

it("recovers pending events once and retains decisions after reopening", async () => {
  const f = await setup();
  try {
    expect(
      processPendingDecisions(f.db, { config: f.config, now: () => 0 }),
    ).toBe(1);
    expect(
      processPendingDecisions(f.db, { config: f.config, now: () => 1 }),
    ).toBe(0);
    const id = String(f.db.prepare("SELECT id FROM decisions").get()?.id);
    f.db.close();
    const reopened = new DatabaseSync(f.path);
    reopened.exec("PRAGMA foreign_keys=ON");
    try {
      migrateDecisionCore(reopened);
      expect(getDecision(reopened, id)?.type).toBe("authorize_execution");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
it("rolls back a partially written decision and recovers it", async () => {
  const f = await setup();
  try {
    const request = {
      requestId: "crash",
      eventId: f.ev.eventId,
      rootId: f.ev.rootId!,
      generation: 1,
    };
    expect(() =>
      evaluateDecision(f.db, request, {
        config: f.config,
        now: () => 0,
        onStage: () => {
          throw Error("injected");
        },
      }),
    ).toThrow("injected");
    expect(f.db.prepare("SELECT COUNT(*) n FROM decisions").get()?.n).toBe(0);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM decision_requests").get()?.n,
    ).toBe(0);
    expect(
      evaluateDecision(f.db, request, { config: f.config, now: () => 0 })
        .status,
    ).toBe("created");
  } finally {
    f.close();
  }
});
it("records distinct events of one root separately without execution", async () => {
  const f = await setup();
  try {
    const other = ingestEvent(
      f.db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: "evt2",
        type: "demo.color",
        payload: {},
        automationId: "auto",
        correlationKey: "one",
      },
      { knownTypes: new Set(["demo.color"]), now: () => 1 },
    );
    expect(other.rootId).toBe(f.ev.rootId);
    expect(
      processPendingDecisions(f.db, { config: f.config, now: () => 0 }),
    ).toBe(2);
    expect(f.db.prepare("SELECT COUNT(*) n FROM decisions").get()?.n).toBe(2);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(0);
  } finally {
    f.close();
  }
});

it("Hub recovers post-commit pending events and rejects client-supplied authority", async () => {
  const f = await setup();
  f.db.close();
  const hub = createHub(f.path, f.config, () => 0, 0, { dispatcherPollMs: 0 });
  try {
    const listed = await hub.inject({
      method: "GET",
      url: `/api/roots/${f.ev.rootId}/decisions`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].type).toBe("authorize_execution");
    const spoof = await hub.inject({
      method: "POST",
      url: `/api/events/${f.ev.eventId}/decide`,
      payload: {
        rootId: f.ev.rootId,
        requestId: "spoof",
        agentProfileId: "admin",
      },
    });
    expect(spoof.statusCode).toBe(400);
    const repeat = await hub.inject({
      method: "POST",
      url: `/api/events/${f.ev.eventId}/decide`,
      payload: { rootId: f.ev.rootId, requestId: "repeat" },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().status).toBe("duplicate");
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
it("persists 1000 distinct decisions without starting agents", async () => {
  const f = await setup();
  try {
    for (let i = 0; i < 1000; i++) {
      const e = ingestEvent(
        f.db,
        { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
        {
          sourceEventId: `performance-${i}`,
          type: "demo.color",
          payload: {},
          automationId: "auto",
          correlationKey: "one",
        },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      );
      evaluateDecision(
        f.db,
        {
          requestId: `performance-${i}`,
          eventId: e.eventId,
          rootId: e.rootId!,
          generation: 1,
        },
        { config: f.config, now: () => 0 },
      );
    }
    expect(f.db.prepare("SELECT COUNT(*) n FROM decisions").get()?.n).toBe(
      1000,
    );
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(0);
  } finally {
    f.close();
  }
}, 30000);

it("two processes converge on one immutable decision", async () => {
  const f = await setup();
  const configPath = join(f.home, "config.json");
  writeFileSync(configPath, JSON.stringify(f.config));
  const children = ["race-a", "race-b"].map((id) =>
    fork(
      join(process.cwd(), "tests/fixtures/decision-race.mjs"),
      [f.path, configPath, f.ev.eventId, f.ev.rootId!, id],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    ),
  );
  try {
    const run = children.map(
      (c) =>
        new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("decision race timeout")),
            10000,
          );
          c.on("message", (m) => {
            if (m === "ready") c.send("go");
            else {
              clearTimeout(timer);
              resolve(m);
            }
          });
          c.once("error", reject);
        }),
    );
    const results = await Promise.all(run);
    expect(results.every((r) => r.result)).toBe(true);
    expect(new Set(results.map((r) => r.result.decision.id)).size).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM decisions").get()?.n).toBe(1);
  } finally {
    for (const c of children) if (c.exitCode === null && !c.killed) c.kill();
    f.close();
  }
});

it("evaluates one event independently for each correlated Root", async () => {
  const f = await setup();
  try {
    createDefinition(
      f.db,
      "auto-two",
      "Other",
      { policy: { effect: "ignore", eventTypes: ["demo.color"] } },
      "2026-01-01T00:00:00Z",
    );
    const event = ingestEvent(
      f.db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: "multi",
        type: "demo.color",
        payload: { agent: "admin" },
        automationIds: ["auto", "auto-two"],
        correlationKey: "multi",
      },
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    processPendingDecisions(f.db, { config: f.config, now: () => 0 });
    const rows = f.db
      .prepare(
        "SELECT decision_type FROM decisions WHERE event_id=? ORDER BY decision_type",
      )
      .all(event.eventId);
    expect(rows.map((r) => r.decision_type)).toEqual([
      "authorize_execution",
      "ignore",
    ]);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(0);
  } finally {
    f.close();
  }
});

it("uses the Root's pinned definition rather than the latest version", async () => {
  const f = await setup();
  try {
    addDefinitionVersion(
      f.db,
      "auto",
      2,
      { policy: { effect: "ignore", eventTypes: ["demo.color"] } },
      "2026-01-02",
    );
    const decision = evaluateDecision(
      f.db,
      {
        requestId: "pinned",
        eventId: f.ev.eventId,
        rootId: f.ev.rootId!,
        generation: 1,
      },
      { config: f.config, now: () => 0 },
    ).decision;
    expect(decision.definitionVersion).toBe(1);
    expect(decision.type).toBe("authorize_execution");
  } finally {
    f.close();
  }
});

it("recovers an Event after the decision writer is killed mid-transaction", async () => {
  const f = await setup();
  const configPath = join(f.home, "kill-config.json");
  writeFileSync(configPath, JSON.stringify(f.config));
  const child = fork(
    join(process.cwd(), "tests/fixtures/decision-kill.mjs"),
    [f.path, configPath, f.ev.eventId, f.ev.rootId!],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("decision checkpoint timeout")),
        10000,
      );
      child.on("message", (m) => {
        if (m === "decision-inserted") {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(Error("decision writer exited early"));
      });
    });
    const done = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGKILL");
    await done;
    expect(f.db.prepare("SELECT COUNT(*) n FROM decisions").get()?.n).toBe(0);
    expect(
      f.db.prepare("SELECT COUNT(*) n FROM decision_requests").get()?.n,
    ).toBe(0);
    expect(
      processPendingDecisions(f.db, { config: f.config, now: () => 0 }),
    ).toBe(1);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill();
    f.close();
  }
});
