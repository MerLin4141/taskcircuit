// Guards shipped templates against apply drift and against external payloads acquiring runtime authority.
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { resolveCurrentStore } from "../src/storage/generation.js";

const templates = [
  {
    folder: "github-issue-fixer",
    source: "project-github",
    provider: "github",
    eventType: "github.issue.opened",
    rule: "issue-fixer",
    agent: "codex-main",
    adapter: "codex",
    workspace: "project-workspace",
    secretEnv: "TASKCIRCUIT_GITHUB_WEBHOOK_SECRET",
    maxRuns: 8,
    duration: 7200,
  },
  {
    folder: "webhook-task-runner",
    source: "task-webhook",
    provider: "webhook",
    eventType: "webhook.task",
    rule: "webhook-task",
    agent: "claude-main",
    adapter: "claude",
    workspace: "task-workspace",
    secretEnv: "TASKCIRCUIT_WEBHOOK_SECRET",
    maxRuns: 6,
    duration: 3600,
  },
] as const;
type Template = (typeof templates)[number];

const secret = "synthetic-template-test-secret";
const cli = resolve("dist/cli.js");
const run = promisify(execFile);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    while (cleanup.length) await cleanup.pop()!();
  } finally {
    vi.unstubAllEnvs();
  }
});

async function reservePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise<void>((done) => server.close(() => done()));
  if (!address || typeof address === "string")
    throw new Error("Expected an integration port");
  return address.port;
}

async function setup(template: Template) {
  const dir = mkdtempSync(join(tmpdir(), "tc-template-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "state");
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  vi.stubEnv("TASKCIRCUIT_HOME", home);
  vi.stubEnv(template.secretEnv, secret);
  const folder = resolve("examples/templates", template.folder);
  const configPath = join(dir, "taskcircuit.config.json");
  const rulePath = join(dir, "automations.json");
  const example = JSON.parse(
    readFileSync(join(folder, "taskcircuit.config.example.json"), "utf8"),
  ) as Config;
  const ws = example.policyWorkspaces![template.workspace];
  ws.path = workspace;
  ws.allowedRoot = workspace;
  writeFileSync(configPath, JSON.stringify(example));
  copyFileSync(join(folder, "automations.json"), rulePath);

  const config = loadConfig(configPath);
  expect(config.agents[template.agent].adapter).toBe(template.adapter);
  expect(config.channels).toEqual({ local: { type: "local-console" } });
  expect(config.routes).toHaveLength(1);
  const port = await reservePort();
  config.integrationIngress = { ...config.integrationIngress, port };
  const dbPath = await resolveCurrentStore(home);
  const hub = createHub(dbPath, config, undefined, 20, { dispatcherPollMs: 0 });
  cleanup.push(() => hub.close());
  const management = await hub.listen({ host: "127.0.0.1", port: 0 });
  const db = new DatabaseSync(dbPath, { readOnly: true });
  cleanup.push(() => db.close());

  function state() {
    return [
      db.prepare("SELECT * FROM automation_definitions ORDER BY id").all(),
      db
        .prepare(
          "SELECT * FROM automation_definition_versions ORDER BY version",
        )
        .all(),
      db.prepare("SELECT * FROM runtime_changes ORDER BY sequence").all(),
    ];
  }
  async function apply(...flags: string[]) {
    const { stdout } = await run(
      process.execPath,
      [cli, "apply", "automations.json", "--json", ...flags],
      {
        cwd: dir,
        env: {
          ...process.env,
          TASKCIRCUIT_HOME: home,
          TASKCIRCUIT_PORT: new URL(management).port,
        },
        timeout: 6000,
        windowsHide: true,
      },
    );
    return JSON.parse(stdout);
  }

  async function send(delivery: number) {
    const selectors = {
      agent: "external-fixture",
      workspace: "external-fixture",
      capabilities: ["network", "external_action"],
      maxRuns: 9999,
      deadline: "999h",
      notify: ["external-fixture"],
      notifyOnCompleted: false,
      plugin: "external-fixture",
      executable: "external-fixture",
      automationId: "external-fixture",
    };
    const github = template.provider === "github";
    const payload = github
      ? {
          ...JSON.parse(
            readFileSync(
              resolve("tests/fixtures/github/issues-opened.json"),
              "utf8",
            ),
          ),
          ...selectors,
        }
      : { taskId: "fixture-" + delivery, text: "synthetic task", ...selectors };
    if (github) {
      payload.issue.number += delivery;
      payload.issue.body = "External context " + JSON.stringify(selectors);
    }
    const body = JSON.stringify(payload);
    const signed =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const response = await fetch(
      "http://127.0.0.1:" +
        port +
        "/integrations/" +
        template.provider +
        "/" +
        template.source,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(github
            ? {
                "X-GitHub-Event": "issues",
                "X-GitHub-Delivery": "fixture-" + delivery,
                "X-Hub-Signature-256": signed,
              }
            : {
                "X-TaskCircuit-Delivery": "fixture-" + delivery,
                "X-TaskCircuit-Signature-256": signed,
              }),
        },
        body,
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    return selectors;
  }

  return { workspace, config, rulePath, db, hub, state, apply, send };
}

describe.each(templates)("$folder", (template) => {
  it("previews without writes, creates through the CLI and reapplies unchanged", async () => {
    const f = await setup(template);
    const before = f.state();
    expect(before[0]).not.toContainEqual(
      expect.objectContaining({ id: template.rule }),
    );
    expect(before[1]).not.toContainEqual(
      expect.objectContaining({ definition_id: template.rule }),
    );
    expect(await f.apply("--dry-run")).toMatchObject({
      documentId: template.folder,
      changes: [{ automation: template.rule, action: "create", toVersion: 1 }],
    });
    expect(f.state()).toEqual(before);
    expect(await f.apply()).toMatchObject({
      changes: [{ automation: template.rule, action: "create", toVersion: 1 }],
    });
    const after = f.state();
    expect(after[0]).toHaveLength(before[0].length + 1);
    expect(after[1]).toHaveLength(before[1].length + 1);
    expect(await f.apply()).toMatchObject({
      changes: [
        {
          automation: template.rule,
          action: "unchanged",
          fromVersion: 1,
          toVersion: 1,
        },
      ],
    });
    expect(f.state()).toEqual(after);
  });

  it("routes signed events with trusted bindings and pins each Root to its applied version", async () => {
    const f = await setup(template);
    await f.apply();
    const selectors = await f.send(1);
    const event = f.db
      .prepare(
        "SELECT type, source_instance, trust_context, payload FROM events",
      )
      .get()!;
    expect(event).toMatchObject({
      type: template.eventType,
      source_instance: template.source,
      trust_context: "external_untrusted",
    });
    const payload = JSON.parse(String(event.payload));
    if (template.provider === "github") {
      expect(payload).not.toHaveProperty("agent");
      expect(payload.issue.body).toContain(JSON.stringify(selectors));
    } else {
      expect(payload).toMatchObject(selectors);
    }

    const work = f.db.prepare(
      "SELECT w.metadata, p.name, p.adapter, p.config FROM work_items w JOIN agent_profiles p ON p.id = w.agent_profile_id",
    );
    await vi.waitFor(() => expect(work.all()).toHaveLength(1));
    const row = work.get()!;
    const caps = [
      ...f.config.policyWorkspaces![template.workspace].allowedCapabilities,
    ].sort();
    expect(caps).toEqual(["read_files", "shell", "write_files"]);
    const doc = JSON.parse(readFileSync(f.rulePath, "utf8"));
    expect(row).toMatchObject({
      name: template.agent,
      adapter: template.adapter,
    });
    expect(JSON.parse(String(row.config))).toEqual({
      isolation: "trusted-local",
      workspaceRoot: f.workspace,
    });
    expect(JSON.parse(String(row.metadata))).toMatchObject({
      authorizedPlan: {
        agentProfileId: template.agent,
        workspaceId: template.workspace,
        workspacePath: f.workspace,
        capabilities: caps,
      },
      instruction: doc.rules[0].instruction,
      notify: ["local"],
      notifyOnCompleted: true,
    });
    expect(
      f.db
        .prepare(
          "SELECT agent_profile_id, workspace_id, capabilities_json FROM decisions",
        )
        .get(),
    ).toEqual({
      agent_profile_id: template.agent,
      workspace_id: template.workspace,
      capabilities_json: JSON.stringify(caps),
    });
    const roots = f.db.prepare(
      "SELECT id, definition_id, definition_version, max_runs, created_at, deadline_at FROM automation_roots ORDER BY definition_version",
    );
    const original = roots.get()!;
    expect(original).toMatchObject({
      definition_id: template.rule,
      definition_version: 1,
      max_runs: template.maxRuns,
    });
    expect(
      Date.parse(String(original.deadline_at)) -
        Date.parse(String(original.created_at)),
    ).toBe(template.duration * 1000);

    doc.rules[0].instruction += " Record the local test command.";
    doc.rules[0].loop = { maxRuns: template.maxRuns - 1, deadline: "30m" };
    writeFileSync(f.rulePath, JSON.stringify(doc));
    expect(await f.apply()).toMatchObject({
      changes: [
        {
          automation: template.rule,
          action: "version",
          fromVersion: 1,
          toVersion: 2,
        },
      ],
    });
    await f.send(2);
    const versions = roots.all();
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual(original);
    expect(versions[1]).toMatchObject({
      definition_id: template.rule,
      definition_version: 2,
      max_runs: template.maxRuns - 1,
    });
    expect(
      Date.parse(String(versions[1].deadline_at)) -
        Date.parse(String(versions[1].created_at)),
    ).toBe(30 * 60 * 1000);
  });
});
