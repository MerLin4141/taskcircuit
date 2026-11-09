// Guards idempotent decision materialization and prevents unbounded autonomous starts.
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
  transitionRoot,
} from "../src/automation-domain.js";
import { migrateEventCore, ingestEvent } from "../src/event-core.js";
import {
  migrateDecisionCore,
  evaluateDecision,
  processPendingDecisions,
  getDecision,
} from "../src/decision-core.js";
import {
  materializeDecision,
  migrateMaterialization,
} from "../src/decision-materialization.js";
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
  migrateMaterialization(db);
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
it("materializes a durable intent exactly once and admits an authorized bounded automation", async () => {
  const f = await setup();
  try {
    const decision = evaluateDecision(
      f.db,
      {
        requestId: "r",
        eventId: f.ev.eventId,
        rootId: f.ev.rootId!,
        generation: 1,
      },
      { config: f.config, now: () => 0 },
    ).decision;
    const a = materializeDecision(f.db, String(decision.id), f.config, () => 0);
    const b = materializeDecision(f.db, String(decision.id), f.config, () => 0);
    expect(a.workItemId).toBe(b.workItemId);
    expect(a.executionId).toBe(b.executionId);
    expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(1);
    f.db.close();
    const hub = createHub(f.path, f.config, () => 0, 0, {
      dispatcherPollMs: 0,
    });
    try {
      expect(
        (
          await hub.inject({
            method: "POST",
            url: "/api/executions/claim",
            payload: { workerId: "w" },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await hub.close();
    }
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
});
it.each(["blocked", "completed"])(
  "does not materialize for %s Root",
  async (status) => {
    const f = await setup();
    try {
      const decision = evaluateDecision(
        f.db,
        {
          requestId: "r",
          eventId: f.ev.eventId,
          rootId: f.ev.rootId!,
          generation: 1,
        },
        { config: f.config, now: () => 0 },
      ).decision;
      f.db
        .prepare("UPDATE automation_roots SET status=? WHERE id=?")
        .run(status, f.ev.rootId!);
      expect(() =>
        materializeDecision(f.db, String(decision.id), f.config, () => 0),
      ).toThrow();
      expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(
        0,
      );
    } finally {
      f.close();
    }
  },
);

it("concurrent processes materialize one work item", async () => {
  const f = await setup();
  try {
    const decision = evaluateDecision(
      f.db,
      {
        requestId: "race",
        eventId: f.ev.eventId,
        rootId: f.ev.rootId!,
        generation: 1,
      },
      { config: f.config, now: () => 0 },
    ).decision;
    const file = join(f.home, "config.json");
    writeFileSync(file, JSON.stringify(f.config));
    const children = [1, 2].map(() =>
      fork(
        join(process.cwd(), "tests/fixtures/materialization-race.mjs"),
        [f.path, file, String(decision.id)],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    try {
      const all = children.map(
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
      );
      const result = await Promise.all(all);
      expect(result.every((x) => x.result)).toBe(true);
      expect(new Set(result.map((x) => x.result.workItemId)).size).toBe(1);
      expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(
        1,
      );
    } finally {
      for (const c of children) if (c.exitCode === null && !c.killed) c.kill();
    }
  } finally {
    f.close();
  }
});
it("fails closed if the trusted workspace changes before materialization", async () => {
  const f = await setup();
  try {
    const d = evaluateDecision(
      f.db,
      {
        requestId: "safe",
        eventId: f.ev.eventId,
        rootId: f.ev.rootId!,
        generation: 1,
      },
      { config: f.config, now: () => 0 },
    ).decision;
    const changed = {
      ...f.config,
      policyWorkspaces: {
        safe: {
          ...f.config.policyWorkspaces.safe,
          allowedCapabilities: ["read_files", "shell"],
        },
      },
    };
    expect(() =>
      materializeDecision(f.db, String(d.id), changed, () => 0),
    ).toThrow();
    expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(0);
  } finally {
    f.close();
  }
});

it("keeps a Root open while an authorized Decision is not materialized", async () => {
  const f = await setup();
  try {
    const first = evaluateDecision(
      f.db,
      {
        requestId: "root-first",
        eventId: f.ev.eventId,
        rootId: f.ev.rootId!,
        generation: 1,
      },
      { config: f.config, now: () => 0 },
    ).decision;
    const materialized = materializeDecision(
      f.db,
      String(first.id),
      f.config,
      () => 0,
    );
    const ev = ingestEvent(
      f.db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: "root-second",
        type: "demo.color",
        payload: {},
        automationId: "auto",
        correlationKey: "one",
      },
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    const second = evaluateDecision(
      f.db,
      {
        requestId: "root-second",
        eventId: ev.eventId,
        rootId: ev.rootId!,
        generation: 1,
      },
      { config: f.config, now: () => 0 },
    ).decision;
    f.db
      .prepare("UPDATE executions SET status='completed' WHERE id=?")
      .run(materialized.executionId!);
    f.db
      .prepare("UPDATE work_items SET status='completed' WHERE id=?")
      .run(materialized.workItemId);
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId!)?.status,
    ).toBe("waiting");
    expect(() => transitionRoot(f.db, f.ev.rootId!, "completed")).toThrow();
    const resumed = materializeDecision(
      f.db,
      String(second.id),
      f.config,
      () => 0,
    );
    expect(resumed.workItemId).toBe(materialized.workItemId);
    expect(resumed.executionId).not.toBe(materialized.executionId);
    expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(1);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(2);
  } finally {
    f.close();
  }
});

it("freezes different workspaces independently when profiles match", async () => {
  const f = await setup();
  try {
    const second = join(f.home, "second");
    mkdirSync(second);
    const config = {
      ...f.config,
      policyWorkspaces: {
        ...f.config.policyWorkspaces,
        other: {
          path: second,
          allowedRoot: f.home,
          allowedCapabilities: ["read_files"],
        },
      },
    };
    createDefinition(
      f.db,
      "other-auto",
      "Other",
      {
        policy: {
          effect: "authorize",
          eventTypes: ["demo.color"],
          agentProfileId: "demo-agent",
          agentProfileSnapshot: defaultConfig.agents["demo-agent"],
          workspaceId: "other",
          workspacePath: second,
          workspaceAllowedRoot: f.home,
          allowedCapabilities: ["read_files"],
          requestedCapabilities: ["read_files"],
          requiresApproval: false,
        },
      },
      "2026-01-01",
    );
    const other = ingestEvent(
      f.db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: "other-event",
        type: "demo.color",
        payload: {},
        automationId: "other-auto",
        correlationKey: "two",
      },
      { knownTypes: new Set(["demo.color"]), now: () => 0 },
    );
    const a = evaluateDecision(
      f.db,
      {
        requestId: "first-workspace",
        eventId: f.ev.eventId,
        rootId: f.ev.rootId!,
        generation: 1,
      },
      { config, now: () => 0 },
    ).decision;
    const b = evaluateDecision(
      f.db,
      {
        requestId: "second-workspace",
        eventId: other.eventId,
        rootId: other.rootId!,
        generation: 1,
      },
      { config, now: () => 0 },
    ).decision;
    const x = materializeDecision(f.db, String(a.id), config, () => 0);
    const y = materializeDecision(f.db, String(b.id), config, () => 0);
    const read = (id: string) =>
      f.db
        .prepare(
          "SELECT p.config FROM work_items w JOIN agent_profiles p ON p.id=w.agent_profile_id WHERE w.id=?",
        )
        .get(id);
    expect(JSON.parse(String(read(x.workItemId)?.config)).workspaceRoot).toBe(
      f.workspace,
    );
    expect(JSON.parse(String(read(y.workItemId)?.config)).workspaceRoot).toBe(
      second,
    );
  } finally {
    f.close();
  }
});

it("recovers a committed Decision after Hub restart without launching the Agent", async () => {
  const f = await setup();
  const decision = evaluateDecision(
    f.db,
    {
      requestId: "recovery",
      eventId: f.ev.eventId,
      rootId: f.ev.rootId!,
      generation: 1,
    },
    { config: f.config, now: () => 0 },
  ).decision;
  f.db.close();
  const hub = createHub(f.path, f.config, () => 0, 0, { dispatcherPollMs: 0 });
  try {
    await hub.ready();
    const db = new DatabaseSync(f.path, { readOnly: true });
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) n FROM decision_materializations WHERE decision_id=?",
          )
          .get(String(decision.id))?.n,
      ).toBe(1);
      expect(db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(1);
    } finally {
      db.close();
    }
    expect(
      (
        await hub.inject({
          method: "POST",
          url: "/api/executions/claim",
          payload: { workerId: "test" },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await hub.close();
    rmSync(f.home, { recursive: true, force: true });
  }
});
it.each(["ignore", "block", "wait"])(
  "does not materialize %s Decisions",
  async (effect) => {
    const f = await setup();
    try {
      createDefinition(
        f.db,
        `auto-${effect}`,
        effect,
        { policy: { effect, eventTypes: ["demo.color"] } },
        "2026-01-01",
      );
      const ev = ingestEvent(
        f.db,
        { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
        {
          sourceEventId: `event-${effect}`,
          type: "demo.color",
          payload: {},
          automationId: `auto-${effect}`,
          correlationKey: "one",
        },
        { knownTypes: new Set(["demo.color"]), now: () => 0 },
      );
      const d = evaluateDecision(
        f.db,
        {
          requestId: `req-${effect}`,
          eventId: ev.eventId,
          rootId: ev.rootId!,
          generation: 1,
        },
        { config: f.config, now: () => 0 },
      ).decision;
      expect(() =>
        materializeDecision(f.db, String(d.id), f.config, () => 0),
      ).toThrow();
      expect(f.db.prepare("SELECT COUNT(*) n FROM work_items").get()?.n).toBe(
        0,
      );
    } finally {
      f.close();
    }
  },
);
