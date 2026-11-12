// Verifies the selected config governs the CLI, plugin anchor, and full template flow.
import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfigPath } from "../src/config-path.js";

const run = promisify(execFile);
const cli = resolve("dist/cli.js");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "TaskCircuit UX "));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function ports() {
  const servers = [createServer(), createServer()];
  await Promise.all(
    servers.map(async (server) => {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }),
  );
  try {
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No loopback port");
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) => new Promise<void>((done) => server.close(() => done())),
      ),
    );
  }
}

async function launch(
  role: "hub" | "worker",
  config: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  preload: string[],
) {
  const child = fork(cli, [role, "--config", config], {
    cwd,
    env,
    execArgv: preload,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exited = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (data) => {
    stdout += data;
  });
  child.stderr?.setEncoding("utf8").on("data", (data) => {
    stderr += data;
  });
  cleanups.push(async () => {
    if (child.connected) child.send({ type: "shutdown" });
    const guard = setTimeout(() => child.kill(), 7000);
    try {
      await exited;
    } finally {
      clearTimeout(guard);
    }
  });
  await new Promise<void>((done, fail) => {
    const guard = setTimeout(
      () => fail(new Error(role + " startup timeout " + stderr)),
      6000,
    );
    const listener = (message: unknown) => {
      if ((message as { type?: string } | null)?.type === "ready") {
        clearTimeout(guard);
        child.off("message", listener);
        done();
      }
    };
    child.on("message", listener);
    child.once("error", (error) => {
      clearTimeout(guard);
      fail(error);
    });
    child.once("exit", () => {
      clearTimeout(guard);
      fail(new Error(role + " exited " + stderr));
    });
  });
  return { output: () => stdout + stderr };
}

it("resolves CLI, environment, cwd and managed-default selections without falling back on a missing explicit file", () => {
  const dir = temp();
  const cwd = join(dir, "taskcircuit.config.json");
  const env = join(dir, "env config.json");
  const flag = join(dir, "flag config.json");
  for (const path of [cwd, env, flag]) writeFileSync(path, "{}");
  expect(
    resolveConfigPath(
      "flag config.json",
      { TASKCIRCUIT_CONFIG: "env config.json" },
      dir,
    ),
  ).toBe(realpathSync(flag));
  expect(
    resolveConfigPath(
      undefined,
      { TASKCIRCUIT_CONFIG: "env config.json" },
      dir,
    ),
  ).toBe(realpathSync(env));
  expect(resolveConfigPath(undefined, {}, dir)).toBe(realpathSync(cwd));
  expect(
    resolveConfigPath(undefined, { TASKCIRCUIT_CONFIG_DEFAULT: "1" }, dir),
  ).toBeNull();
  expect(resolveConfigPath(undefined, {}, temp())).toBeNull();
  expect(() =>
    resolveConfigPath("missing.json", { TASKCIRCUIT_CONFIG: env }, dir),
  ).toThrow("missing.json");
  expect(() =>
    resolveConfigPath(undefined, { TASKCIRCUIT_CONFIG: "missing.json" }, dir),
  ).toThrow("missing.json");
});

it("rejects missing or malformed selected configs and explains an unavailable Hub", async () => {
  const dir = temp();
  const [port] = await ports();
  const home = join(dir, "state");
  const env = {
    ...process.env,
    TASKCIRCUIT_HOME: home,
    TASKCIRCUIT_PORT: String(port),
    TASKCIRCUIT_CONFIG: "missing env.json",
  };
  writeFileSync(
    join(dir, "taskcircuit.config.json"),
    '{"agents":{},"routes":[]}',
  );
  writeFileSync(join(dir, "bad.json"), "{not-json-sensitive-fixture");
  const command = (...args: string[]) =>
    run(process.execPath, [cli, ...args], {
      cwd: dir,
      env,
      windowsHide: true,
      timeout: 7000,
    });
  await expect(
    command("hub", "--config", "missing flag.json"),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(/config_not_found.*missing flag\.json/),
  });
  await expect(command("worker", "--once")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(/config_not_found.*missing env\.json/),
  });
  const failure = await command(
    "doctor",
    "--config",
    "bad.json",
    "--json",
  ).catch((error) => error);
  expect(failure.code).toBe(1);
  expect(JSON.parse(failure.stdout).config).toMatchObject({
    status: "FAIL",
    code: "config_invalid",
  });
  expect(failure.stdout + failure.stderr).not.toContain(
    "not-json-sensitive-fixture",
  );
  writeFileSync(join(dir, "rule.json"), "{}");
  await expect(command("apply", "rule.json")).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("hub_unavailable"),
  });
  expect(existsSync(home)).toBe(false);
}, 15000);

it("preflights an offline config without importing plugins or disclosing credential values", async () => {
  const dir = temp();
  const [port, ingress] = await ports();
  const home = join(dir, "home");
  const pluginMarker = join(dir, "unexpected-import");
  const configPath = join(dir, "custom configuration.json");
  const url =
    "https://open.feishu.cn/open-apis/bot/v2/hook/" + "fake-diagnostic-fixture";
  const sign = "conspicuous-fake-feishu-signing-material";
  writeFileSync(
    join(dir, "external.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync(" +
      JSON.stringify(pluginMarker) +
      ", 'loaded');",
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: { test: { adapter: "external-agent" } },
      plugins: {
        worker: [
          { id: "external-agent", kind: "agent", module: "./external.mjs" },
        ],
      },
      routes: [],
      integrationIngress: { port: ingress },
      policyWorkspaces: {
        temp: {
          path: dir,
          allowedRoot: dir,
          allowedCapabilities: ["read_files"],
        },
      },
      sources: {
        github: {
          type: "github",
          required: false,
          config: {
            secretEnv: "TASKCIRCUIT_TEST_MISSING_OPTIONAL",
            allowedRepositoryIds: [1],
            allowedSenderIds: [2],
          },
        },
        generic: {
          type: "webhook",
          config: {
            secretEnv: "TASKCIRCUIT_TEST_MISSING_REQUIRED",
            eventType: "webhook.task",
          },
        },
      },
      channels: {
        local: { type: "local-console" },
        team: {
          type: "feishu-channel",
          config: {
            webhookUrlEnv: "TASKCIRCUIT_TEST_FEISHU_URL",
            signingSecretEnv: "TASKCIRCUIT_TEST_FEISHU_SIGN",
          },
        },
      },
    }),
  );
  const env = {
    ...process.env,
    TASKCIRCUIT_HOME: home,
    TASKCIRCUIT_PORT: String(port),
    TASKCIRCUIT_TEST_MISSING_OPTIONAL: "",
    TASKCIRCUIT_TEST_MISSING_REQUIRED: "",
    TASKCIRCUIT_TEST_FEISHU_URL: url,
    TASKCIRCUIT_TEST_FEISHU_SIGN: sign,
  };
  const doctor = (...flags: string[]) =>
    run(process.execPath, [cli, "doctor", "--config", configPath, ...flags], {
      cwd: dir,
      env,
      timeout: 9000,
      windowsHide: true,
    }).catch((error) => error);
  const json = await doctor("--json");
  expect(json.code).toBe(1);
  const report = JSON.parse(json.stdout);
  expect(report.config).toMatchObject({
    path: realpathSync(configPath),
    status: "PASS",
  });
  expect(report.sources.detail).toEqual([
    expect.objectContaining({
      id: "github",
      status: "WARN",
      references: [
        { name: "TASKCIRCUIT_TEST_MISSING_OPTIONAL", state: "MISSING" },
      ],
    }),
    expect.objectContaining({
      id: "generic",
      status: "FAIL",
      references: [
        { name: "TASKCIRCUIT_TEST_MISSING_REQUIRED", state: "MISSING" },
      ],
    }),
  ]);
  expect(report.channels.detail).toContainEqual(
    expect.objectContaining({
      id: "team",
      status: "PASS",
      references: [
        { name: "TASKCIRCUIT_TEST_FEISHU_URL", state: "SET" },
        { name: "TASKCIRCUIT_TEST_FEISHU_SIGN", state: "SET" },
      ],
    }),
  );
  expect(report.hub.status).toBe("WARN");
  expect(report.workspaces.detail).toContainEqual(
    expect.objectContaining({ id: "temp", status: "PASS" }),
  );
  const human = await doctor();
  expect(human.stdout).toContain("TASKCIRCUIT_TEST_FEISHU_SIGN SET");
  const failedHub = await run(
    process.execPath,
    [cli, "hub", "--config", configPath],
    {
      cwd: dir,
      env,
      timeout: 7000,
      windowsHide: true,
    },
  ).catch((error) => error);
  expect(failedHub.stderr).toMatch(
    /required_environment_missing.*generic.*TASKCIRCUIT_TEST_MISSING_REQUIRED/,
  );
  for (const value of [url, "fake-diagnostic-fixture", sign])
    expect(
      json.stdout +
        json.stderr +
        human.stdout +
        human.stderr +
        failedHub.stderr,
    ).not.toContain(value);
  expect(existsSync(pluginMarker)).toBe(false);
  expect(existsSync(home)).toBe(false);
}, 15000);

it("runs the copied webhook template from outside the application using a relative plugin beside the selected config", async () => {
  const dir = temp();
  const project = join(dir, "User Automation Project");
  const launchDir = join(dir, "Shell Directory");
  const workspace = join(dir, "Workspace");
  const home = join(dir, "State");
  for (const path of [project, launchDir, workspace]) mkdirSync(path);
  const [management, ingress] = await ports();
  const configPath = join(project, "taskcircuit.config.json");
  const example = resolve("examples/templates/webhook-task-runner");
  const config = JSON.parse(
    readFileSync(join(example, "taskcircuit.config.example.json"), "utf8"),
  );
  config.integrationIngress.port = ingress;
  config.policyWorkspaces["task-workspace"].path = workspace;
  config.policyWorkspaces["task-workspace"].allowedRoot = workspace;
  config.agents["claude-main"].adapter = "fixture-mock";
  config.plugins = {
    worker: [{ id: "fixture-mock", kind: "agent", module: "./mock-agent.mjs" }],
  };
  config.channels.team = {
    type: "feishu-channel",
    config: {
      webhookUrlEnv: "TASKCIRCUIT_TEST_UX_FEISHU_URL",
      signingSecretEnv: "TASKCIRCUIT_TEST_UX_FEISHU_SIGN",
    },
  };
  writeFileSync(configPath, JSON.stringify(config));
  const unchanged = readFileSync(configPath, "utf8");
  const rulePath = join(project, "automations.json");
  copyFileSync(join(example, "automations.json"), rulePath);
  writeFileSync(
    join(launchDir, "taskcircuit.config.json"),
    "{ invalid cwd config",
  );
  const marker = join(project, "worker-anchor.json");
  const secret = "fake-template-hmac-for-ux";
  const url = "https://open.feishu.cn/open-apis/bot/v2/hook/" + "fake-ux-only";
  const signing = "fake-template-feishu-for-ux";
  writeFileSync(
    join(project, "mock-agent.mjs"),
    [
      "import { MockAgentAdapter } from " +
        JSON.stringify(pathToFileURL(resolve("dist/adapter.js")).href) +
        ";",
      "import { writeFileSync } from 'node:fs';",
      "const absent = !process.env.TASKCIRCUIT_WEBHOOK_SECRET && !process.env.TASKCIRCUIT_TEST_UX_FEISHU_URL && !process.env.TASKCIRCUIT_TEST_UX_FEISHU_SIGN;",
      "const adapter = new MockAgentAdapter();",
      'export default () => ({ manifest: { id: "fixture-mock", kind: "agent", apiVersion: 1, version: "1" }, async execute(input, signal) {',
      "writeFileSync(" +
        JSON.stringify(marker) +
        ", JSON.stringify({ absent, workspace: input.workingDirectory }));",
      "return adapter.execute(input, signal); } });",
    ].join("\n"),
  );
  const probe = join(dir, "only-loopback.mjs");
  const externalAttempt = join(dir, "external-attempt");
  writeFileSync(
    probe,
    [
      "import { writeFileSync } from 'node:fs';",
      "const original = globalThis.fetch;",
      "globalThis.fetch = (url, ...args) => {",
      'if (new URL(url).hostname !== "127.0.0.1") { writeFileSync(' +
        JSON.stringify(externalAttempt) +
        ', "unexpected"); throw new Error("Fixture permits only loopback"); }',
      "return original(url, ...args); };",
    ].join("\n"),
  );
  const preload = ["--import", pathToFileURL(probe).href];
  const env = {
    ...process.env,
    TASKCIRCUIT_HOME: home,
    TASKCIRCUIT_PORT: String(management),
    TASKCIRCUIT_CONFIG: "missing env choice.json",
    TASKCIRCUIT_SCHEDULER_INTERVAL_MS: "25",
    TASKCIRCUIT_WEBHOOK_SECRET: secret,
    TASKCIRCUIT_TEST_UX_FEISHU_URL: url,
    TASKCIRCUIT_TEST_UX_FEISHU_SIGN: signing,
  };
  const flag = relative(launchDir, configPath);
  const command = (...args: string[]) =>
    run(process.execPath, [...preload, cli, ...args], {
      cwd: launchDir,
      env,
      windowsHide: true,
      timeout: 9000,
    });
  const offline = await command("doctor", "--config", flag, "--json");
  const preflight = JSON.parse(offline.stdout);
  expect(preflight.config.path).toBe(realpathSync(configPath));
  expect(preflight.hub.status).toBe("WARN");
  expect(existsSync(home)).toBe(false);
  const viaEnv = await run(
    process.execPath,
    [...preload, cli, "doctor", "--json"],
    {
      cwd: launchDir,
      env: { ...env, TASKCIRCUIT_CONFIG: flag },
      windowsHide: true,
      timeout: 9000,
    },
  );
  expect(JSON.parse(viaEnv.stdout).config.path).toBe(realpathSync(configPath));
  const hub = await launch("hub", flag, launchDir, env, preload);
  const worker = await launch("worker", flag, launchDir, env, preload);
  const base = "http://127.0.0.1:" + management;
  async function get(path: string) {
    const response = await fetch(base + path);
    expect(response.ok).toBe(true);
    return response.json();
  }
  const runtimeDoctor = await command("doctor", "--config", flag, "--json");
  const report = JSON.parse(runtimeDoctor.stdout);
  expect(report.hub.detail.sources).toContainEqual(
    expect.objectContaining({ id: "task-webhook", state: "healthy" }),
  );
  expect(report.hub.detail.channels).toContainEqual(
    expect.objectContaining({ id: "team", state: "healthy" }),
  );
  expect(report.runtimeIngress.detail).toMatchObject({
    host: "127.0.0.1",
    port: ingress,
  });
  expect(await get("/api/roots")).toEqual([]);
  const dry = await command("apply", rulePath, "--dry-run", "--json");
  expect(JSON.parse(dry.stdout).summary.create).toBe(1);
  expect(
    (await get("/api/automations")).map((item: { id: string }) => item.id),
  ).not.toContain("webhook-task");
  const apply = await command("apply", rulePath, "--json");
  expect(JSON.parse(apply.stdout).summary.create).toBe(1);
  const body = '{"taskId":"ux","text":"Review the local project"}';
  const response = await fetch(
    "http://127.0.0.1:" + ingress + "/integrations/webhook/task-webhook",
    {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "X-TaskCircuit-Delivery": "ux-1",
        "X-TaskCircuit-Signature-256":
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
      },
    },
  );
  expect(response.status).toBe(202);
  const inbox = await vi.waitFor(
    async () => {
      const inbox = await get("/api/inbox");
      expect(inbox).toHaveLength(1);
      return inbox;
    },
    { timeout: 5000 },
  );
  await command("answer", inbox[0].interactionId, "蓝色");
  await vi.waitFor(
    async () => {
      expect(await get("/api/roots")).toEqual([
        expect.objectContaining({
          automation: "webhook-task",
          status: "completed",
          runs: 2,
        }),
      ]);
      const notices = await get("/api/notifications");
      expect(notices).toContainEqual(
        expect.objectContaining({
          kind: "work_item_completed",
          deliveries: [
            expect.objectContaining({ channelId: "local", status: "sent" }),
          ],
        }),
      );
    },
    { timeout: 7000 },
  );
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
    absent: true,
    workspace: realpathSync(workspace),
  });
  expect(readFileSync(configPath, "utf8")).toBe(unchanged);
  expect(existsSync(externalAttempt)).toBe(false);
  for (const value of [secret, url, signing])
    expect(
      offline.stdout + runtimeDoctor.stdout + hub.output() + worker.output(),
    ).not.toContain(value);
}, 30000);
