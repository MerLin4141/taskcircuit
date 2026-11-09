// Guards automatic Continue against duplicate execution and frozen Root run limits.
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { createHub } from "../src/hub.js";
import { createDefinition } from "../src/automation-domain.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
it("automatically continues twice then completes inside the same Root, Work Item and Session", async () => {
  const home = mkdtempSync(join(tmpdir(), "tc-p5-loop-"));
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
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const hub = createHub(path, config, () => clock, 5, { dispatcherPollMs: 0 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  try {
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
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    const ev = (
      await hub.inject({
        method: "POST",
        url: "/api/events/v2",
        payload: {
          sourceEventId: "event",
          type: "demo.color",
          automationId: "a",
          correlationKey: "subject",
          payload: {},
        },
      })
    ).json();
    let count = 0;
    const observed: string[] = [];
    const adapter = {
      async execute(input: any) {
        count++;
        observed.push(input.externalSessionId ?? "first");
        return count < 3
          ? { type: "continue" as const, sessionId: "fake", message: "next" }
          : { type: "completed" as const, sessionId: "fake", output: "done" };
      },
    };
    for (let i = 0; i < 3; i++)
      expect(await workOnce(base, "test-worker", adapter)).toBe(true);
    expect(count).toBe(3);
    expect(observed).toEqual(["first", "fake", "fake"]);
    expect(
      db
        .prepare("SELECT COUNT(*) n FROM work_items WHERE root_id=?")
        .get(ev.rootId)?.n,
    ).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(3);
    expect(
      db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(ev.rootId)?.status,
    ).toBe("completed");
  } finally {
    db.close();
    await hub.close();
    if (oldHome === undefined) delete process.env.TASKCIRCUIT_HOME;
    else process.env.TASKCIRCUIT_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});

import { fork } from "node:child_process";
import { setupLoop } from "./fixtures/phase5-setup.js";
it("runs a three-Execution fake loop in a background Worker without manual advancement", async () => {
  const f = await setupLoop(3, 120);
  try {
    const child = fork(
      join(process.cwd(), "tests/fixtures/phase5-background-worker.mjs"),
      [f.base],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, TASKCIRCUIT_HOME: join(f.home, "state") },
      },
    );
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("background worker timeout")),
          10000,
        );
        child.on("message", (m) => {
          clearTimeout(timeout);
          resolve(m);
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code) {
            clearTimeout(timeout);
            reject(Error(`worker exit ${code}`));
          }
        });
      });
      expect(result).toMatchObject({
        calls: 3,
        sessions: ["first", "fake", "fake"],
      });
      expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
        3,
      );
      expect(
        f.db
          .prepare("SELECT status FROM automation_roots WHERE id=?")
          .get(f.ev.rootId)?.status,
      ).toBe("completed");
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  } finally {
    await f.close();
  }
});
