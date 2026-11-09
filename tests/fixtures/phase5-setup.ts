import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { resolveCurrentStore } from "../../src/storage/generation.js";
import { createHub } from "../../src/hub.js";
import { createDefinition } from "../../src/automation-domain.js";
import { defaultConfig } from "../../src/config.js";
export async function setupLoop(
  maxRuns = 3,
  duration = 120,
  retryPolicy?: unknown,
) {
  const home = mkdtempSync(join(tmpdir(), "tc-p5-fixture-"));
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
  let time = Date.parse("2026-01-01T00:00:00Z");
  let hub = createHub(path, config, () => time, 0, { dispatcherPollMs: 0 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  createDefinition(
    db,
    "a",
    "Auto",
    {
      ...(retryPolicy === undefined ? {} : { retryPolicy }),
      loop: { maxRuns, maxDurationSeconds: duration },
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
  let base = await hub.listen({ port: 0, host: "127.0.0.1" });
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
  return {
    home,
    path,
    db,
    get hub() {
      return hub;
    },
    get base() {
      return base;
    },
    ev,
    config,
    advance(ms: number) {
      time += ms;
    },
    async restart() {
      await hub.close();
      hub = createHub(path, config, () => time, 0, { dispatcherPollMs: 0 });
      base = await hub.listen({ port: 0, host: "127.0.0.1" });
    },
    async close() {
      db.close();
      await hub.close();
      if (oldHome === undefined) delete process.env.TASKCIRCUIT_HOME;
      else process.env.TASKCIRCUIT_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
