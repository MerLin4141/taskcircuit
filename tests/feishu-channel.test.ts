// Guards signed transport, credential-safe failures, and durable notifications independent of agent results.
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { formatDoctor } from "../src/cli-format.js";
import { defaultConfig, loadConfig, type Config } from "../src/config.js";
import { workerEnvironment } from "../src/integrations/environment.js";
import { createFeishuPlugin } from "../src/plugins/builtin/feishu.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { resolveCurrentStore } from "../src/storage/generation.js";
import { createHub } from "./fixtures/g2-hub.js";

const urlEnv = "TASKCIRCUIT_TEST_FEISHU_URL";
const secretEnv = "TASKCIRCUIT_TEST_FEISHU_SIGN";
const endpoint = "https://open.feishu.cn/open-apis/bot/v2/hook/";
const token = "fixture-hook-id";
const url = endpoint + token;
const secret = "fixture-signing-key";
const config = {
  webhookUrlEnv: urlEnv,
  signingSecretEnv: secretEnv,
  timeoutMs: 1000,
};
const input = {
  kind: "interaction_required",
  severity: "info",
  notificationId: "note",
  deliveryId: "delivery",
  workItemId: "work",
  interactionId: "interaction",
  title: "中文问题",
  body: "请选择",
};

const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  try {
    while (disposals.length) await disposals.pop()!();
  } finally {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});

function credentials() {
  vi.stubEnv(urlEnv, url);
  vi.stubEnv(secretEnv, secret);
}

function localTransport(serverUrl: string) {
  return vi.fn<typeof fetch>(async (target, init) =>
    fetch(serverUrl + "/" + String(target).split("/").at(-1), init),
  );
}

async function serve(handler: RequestListener) {
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("expected loopback port");
  disposals.push(async () => {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
  });
  return "http://127.0.0.1:" + address.port;
}

function instance(
  transport: typeof fetch,
  {
    signal = new AbortController().signal,
    now = () => 1710000000000,
    overrides = {},
  } = {},
) {
  const reportHealth = vi.fn();
  const channel = createFeishuPlugin({ transport, now }).createChannel(
    { id: "team-feishu", config: { ...config, ...overrides } },
    { signal, reportHealth },
  );
  return { channel, reportHealth };
}

it("registers Channel API 2 and rejects invalid credentials, destination and timeout before readiness", () => {
  expect(
    createHubPluginRegistry().getChannel("feishu-channel").manifest.apiVersion,
  ).toBe(2);
  credentials();
  const fixture = {
    ...defaultConfig,
    channels: { team: { type: "feishu-channel", config } },
  };
  const test = (code: string, settings = config) =>
    expect(() =>
      createHub(":memory:", {
        ...fixture,
        channels: { team: { type: "feishu-channel", config: settings } },
      }),
    ).toThrow(code);
  for (const candidate of [
    url.replace("https:", "http:"),
    url.replace("open.feishu.cn", "example.invalid"),
    url.replace("open.feishu.cn", "open.feishu.cn.example.invalid"),
    url.replace("open.feishu.cn", "user:pass@open.feishu.cn"),
    url.replace("open.feishu.cn", "open.feishu.cn:444"),
    endpoint,
    url + "?",
    url + "#fragment",
    url + "\n",
    url.replace("/v2/", "/v1/"),
    endpoint + "one/../two",
    endpoint + "%2f",
  ]) {
    vi.stubEnv(urlEnv, candidate);
    test("feishu_webhook_url_invalid");
  }
  credentials();
  for (const timeoutMs of [999, 10001, 1000.5, NaN])
    test("feishu_timeout_invalid", { ...config, timeoutMs });
  test("integration_secret_reference_invalid", {
    ...config,
    webhookUrlEnv: "TASKCIRCUIT_HOME",
  });
  test("integration_secret_reference_invalid", {
    ...config,
    signingSecretEnv: "FEISHU_SECRET",
  });
  test("integration_secret_reference_invalid", {
    ...config,
    signingSecretEnv: secretEnv + "\n",
  });
  vi.stubEnv(secretEnv, " ");
  test("integration_secret_unavailable");
  credentials();
  vi.stubEnv(urlEnv, undefined);
  test("integration_secret_unavailable");
});

it("posts a signed JSON text request and keeps UTF-8 and escaped JSON within both limits", async () => {
  credentials();
  const received: { body: string; method?: string; type?: string }[] = [];
  const base = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req.setEncoding("utf8")) body += chunk;
    received.push({
      body,
      method: req.method,
      type: req.headers["content-type"],
    });
    res.end('{"code":0,"StatusCode":1}');
  });
  const fetcher = localTransport(base);
  let time = 1710000000000;
  const { channel, reportHealth } = instance(fetcher, { now: () => time });
  expect(fetcher).not.toHaveBeenCalled();
  expect(await channel.deliver(input)).toEqual({ ok: true });
  expect(fetcher.mock.calls[0]).toEqual([
    url,
    expect.objectContaining({
      redirect: "error",
      signal: expect.any(AbortSignal),
    }),
  ]);
  expect(received[0]).toMatchObject({
    method: "POST",
    type: "application/json",
  });
  const first = JSON.parse(received[0].body);
  expect(first).toMatchObject({
    timestamp: "1710000000",
    sign: "UOWHCBFz4ukPXgwFWzgMC2xQhCrvaFUfZicOlCNuDFY=",
    msg_type: "text",
    content: {
      text: expect.stringContaining(
        "TaskCircuit 需要输入\n中文问题\n请选择\nWork Item work",
      ),
    },
  });
  expect(first.content.text).toContain("taskcircuit inbox\ntaskcircuit answer");
  time += 5000;
  const unsafe =
    "\u001b[31m红\u001b[0m\u0000\r\n\t" + url + " " + secret + " " + token;
  expect(
    await channel.deliver({
      ...input,
      kind: "work_item_failed",
      title: unsafe + "中😀".repeat(5000),
      body: '"\\\n'.repeat(20000),
    }),
  ).toEqual({ ok: true });
  const second = JSON.parse(received[1].body);
  expect(second.timestamp).toBe("1710000005");
  expect(second.sign).not.toBe(first.sign);
  expect(Buffer.byteLength(received[1].body)).toBeLessThan(20000);
  expect(Buffer.byteLength(second.content.text)).toBeLessThanOrEqual(12 * 1024);
  expect(second.content.text).toContain("TaskCircuit 执行失败\n红\n\t");
  expect(second.content.text).toContain("中😀");
  expect(second.content.text).toContain("Work Item work");
  for (const marker of [url, token, secret, "\ufffd", "\u001b", "\u0000"])
    expect(second.content.text).not.toContain(marker);
  expect(reportHealth).toHaveBeenLastCalledWith("healthy");
});

it("rejects HTTP and provider failures, malformed and oversized bodies, and never follows redirects", async () => {
  credentials();
  let mode = 0;
  let redirected = 0;
  const base = await serve((req, res) => {
    if (req.url === "/other") {
      redirected++;
      return res.end('{"code":0}');
    }
    switch (mode) {
      case 0:
        return res.end('{"code":11232,"msg":"provider failure"}');
      case 1:
        return res.writeHead(429).end('{"code":0}');
      case 2:
        return res.writeHead(500).end();
      case 3:
        return res.end("invalid JSON");
      case 4:
        return res.end('{"StatusCode":0}');
      case 5:
        res.write('{"code":0,"padding":"');
        return res.end("x".repeat(64 * 1024) + '"}');
      case 6:
        return res.writeHead(307, { location: "/other" }).end();
      case 7:
        return req.socket.destroy();
      default:
        return res.end('{"code":0}');
    }
  });
  const { channel, reportHealth } = instance(localTransport(base));
  for (; mode < 8; mode++)
    expect(await channel.deliver(input)).toEqual({ ok: false });
  expect(redirected).toBe(0);
  expect(reportHealth.mock.calls).toEqual(
    Array.from({ length: 8 }, () => ["degraded"]),
  );
  expect(await channel.deliver(input)).toEqual({ ok: true });
  expect(reportHealth).toHaveBeenLastCalledWith("healthy");
});

it("times out a stalled response body and does not read it indefinitely", async () => {
  credentials();
  let signal: AbortSignal | null | undefined;
  const base = await serve((_req, res) => {
    res.write('{"code":');
  });
  const { channel, reportHealth } = instance((_, init) => {
    signal = init?.signal;
    return fetch(base, init);
  });
  expect(await channel.deliver(input)).toEqual({ ok: false });
  expect(signal?.reason).toMatchObject({ name: "TimeoutError" });
  expect(reportHealth).toHaveBeenLastCalledWith("degraded");
});

const post = async (
  hub: ReturnType<typeof createHub>,
  url: string,
  payload: object,
) => {
  const response = await hub.inject({ method: "POST", url, payload });
  expect(response.statusCode, response.body).toBeLessThan(300);
  return response.json();
};

async function fixture(
  transport: typeof fetch,
  extraChannels: Config["channels"] = {},
) {
  credentials();
  const home = mkdtempSync(join(tmpdir(), "tc-feishu-"));
  disposals.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  mkdirSync(workspace);
  const cfg: Config = {
    ...structuredClone(defaultConfig),
    channels: { team: { type: "feishu-channel", config }, ...extraChannels },
    policyWorkspaces: {
      safe: {
        path: workspace,
        allowedRoot: home,
        allowedCapabilities: ["read_files"],
      },
    },
  };
  let now = 1710000000000;
  const path = await resolveCurrentStore(home);
  const registry = createHubPluginRegistry(
    createFeishuPlugin({ transport, now: () => now }),
  );
  const hub = createHub(
    path,
    cfg,
    () => now,
    0,
    { dispatcherPollMs: 0 },
    { registry, sourceId: "local" },
  );
  disposals.push(() => hub.close());
  const base = await hub.listen({ host: "127.0.0.1", port: 0 });
  const db = new DatabaseSync(path, { readOnly: true });
  disposals.push(() => db.close());
  let next = 0;
  async function submit(
    result: object,
    notifyOnCompleted = true,
    notify = ["team"],
  ) {
    const id = "phase4-" + ++next;
    await post(hub, "/api/automations/apply", {
      dryRun: false,
      document: {
        schemaVersion: 1,
        id,
        rules: [
          {
            name: id,
            when: { source: "local", type: "demo.color" },
            agent: "demo-agent",
            workspace: "safe",
            instruction: "trusted fixture",
            loop: { maxRuns: 3, deadline: "5m" },
            notify,
            notifyOnCompleted,
          },
        ],
      },
    });
    const event = await post(hub, "/api/events/v2", {
      sourceEventId: id,
      type: "demo.color",
      automationId: id,
      payload: { origin: "fixture" },
    });
    const claim = await post(hub, "/api/executions/claim", {
      workerId: "worker",
    });
    await post(hub, "/api/executions/" + claim.execution.id + "/result", {
      workerId: "worker",
      leaseToken: claim.leaseToken,
      result: { ...result, sessionId: id + "-session" },
    });
    return { event, claim };
  }
  return {
    home,
    base,
    db,
    cfg,
    hub,
    submit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const completed = {
  type: "completed",
  sessionId: "fixture-session",
  output: "fixture result",
};
const ask = {
  type: "needs_input",
  sessionId: "fixture-session",
  request: {
    key: "color",
    title: "fixture question",
    text: "choose",
    options: ["yes"],
  },
};

it("preserves results across Feishu failure, retries one delivery, and exposes safe Doctor health", async () => {
  let hits = 0;
  const bodies: {
    timestamp: string;
    sign: string;
    content: { text: string };
  }[] = [];
  const base = await serve(async (req, res) => {
    let body = "";
    for await (const chunk of req.setEncoding("utf8")) body += chunk;
    bodies.push(JSON.parse(body));
    if (++hits === 1)
      return res.end(JSON.stringify({ code: 19021, msg: url + secret }));
    res.end('{"code":0}');
  });
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  const f = await fixture(localTransport(base));
  const health = async () => (await f.hub.inject("/api/health")).json();
  const delivery = () =>
    f.db.prepare("SELECT * FROM notification_deliveries").all();
  expect((await health()).channels[0]).toEqual({
    id: "team",
    implementation: "feishu-channel",
    apiVersion: 2,
    state: "healthy",
  });
  expect(hits).toBe(0);
  await f.submit(completed, false);
  expect(delivery()).toHaveLength(0);
  const { event, claim } = await f.submit(completed);
  await f.hub.dispatchNotifications();
  expect(delivery()).toEqual([
    expect.objectContaining({
      status: "queued",
      attempt: 1,
      last_error: "投递失败",
      not_before: new Date(1710000005000).toISOString(),
      lease_expires_at: new Date(1710000030000).toISOString(),
    }),
  ]);
  expect(
    f.db
      .prepare("SELECT status FROM work_items WHERE id=?")
      .get(claim.execution.workItemId),
  ).toEqual({ status: "completed" });
  expect(
    f.db
      .prepare("SELECT status FROM automation_roots WHERE id=?")
      .get(event.rootId),
  ).toEqual({ status: "completed" });
  const doctor = { hub: { status: "PASS", detail: await health() } };
  expect(formatDoctor(doctor)).toContain(
    "Channel team · feishu-channel · API 2 · degraded",
  );
  const isolatedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toUpperCase() !== "PATH",
    ),
  );
  const cliDoctor = await promisify(execFile)(
    process.execPath,
    [resolve("dist/cli.js"), "doctor", "--json"],
    {
      cwd: f.home,
      windowsHide: true,
      timeout: 4000,
      env: {
        ...isolatedEnv,
        PATH: f.home,
        TASKCIRCUIT_HOME: f.home,
        TASKCIRCUIT_PORT: new URL(f.base).port,
      },
    },
  );
  expect(JSON.parse(cliDoctor.stdout).hub.detail.channels).toEqual(
    doctor.hub.detail.channels,
  );
  for (const marker of [url, token, secret])
    expect(cliDoctor.stdout + cliDoctor.stderr).not.toContain(marker);
  f.advance(4999);
  await f.hub.dispatchNotifications();
  expect(hits).toBe(1);
  f.advance(1);
  await f.hub.dispatchNotifications();
  expect(hits).toBe(2);
  expect(delivery()).toEqual([
    expect.objectContaining({ status: "sent", attempt: 2 }),
  ]);
  expect((await health()).channels[0].state).toBe("healthy");
  expect(bodies[0].content.text).toContain("TaskCircuit 已完成");
  expect(bodies[1].content).toEqual(bodies[0].content);
  expect(bodies[1].timestamp).toBe("1710000005");
  expect(bodies[1].sign).not.toBe(bodies[0].sign);
  const tables = f.db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all();
  const records = tables.flatMap(({ name }) =>
    f.db
      .prepare('SELECT * FROM "' + String(name).replaceAll('"', '""') + '"')
      .all(),
  );
  const observed = JSON.stringify({
    records,
    doctor,
    text: formatDoctor(doctor),
    logs: logger.mock.calls,
  });
  for (const marker of [url, token, secret])
    expect(observed).not.toContain(marker);
});

it("exhausts three sends while NeedsInput remains available and answerable locally", async () => {
  let hits = 0;
  const base = await serve((_req, res) => {
    hits++;
    res.writeHead(500).end();
  });
  const f = await fixture(localTransport(base));
  const { claim } = await f.submit(ask);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.hub.dispatchNotifications();
    expect(
      f.db.prepare("SELECT status, attempt FROM notification_deliveries").all(),
    ).toEqual([{ status: attempt < 3 ? "queued" : "failed", attempt }]);
    f.advance(5000);
  }
  await f.hub.dispatchNotifications();
  expect(hits).toBe(3);
  const inbox = (await f.hub.inject("/api/inbox")).json();
  expect(inbox).toEqual([
    expect.objectContaining({ workItemId: claim.execution.workItemId }),
  ]);
  await post(f.hub, "/api/interactions/" + inbox[0].interactionId + "/answer", {
    answer: "yes",
  });
  expect((await f.hub.inject("/api/inbox")).json()).toEqual([]);
});

it("isolates credentials and target destinations for two configured instances", async () => {
  const secondUrl = endpoint + "second-fixture";
  vi.stubEnv("TASKCIRCUIT_TEST_OPS_URL", secondUrl);
  vi.stubEnv("TASKCIRCUIT_TEST_OPS_SIGN", "second-signing-key");
  const targets: string[] = [];
  const signatures: string[] = [];
  const base = await serve(async (req, res) => {
    targets.push(req.url!);
    let body = "";
    for await (const chunk of req.setEncoding("utf8")) body += chunk;
    signatures.push(JSON.parse(body).sign);
    res.end('{"code":0}');
  });
  const f = await fixture(localTransport(base), {
    ops: {
      type: "feishu-channel",
      config: {
        webhookUrlEnv: "TASKCIRCUIT_TEST_OPS_URL",
        signingSecretEnv: "TASKCIRCUIT_TEST_OPS_SIGN",
      },
    },
  });
  await f.submit(completed, true, ["team", "ops"]);
  await f.hub.dispatchNotifications();
  await f.hub.dispatchNotifications();
  expect(targets.sort()).toEqual(["/" + token, "/second-fixture"].sort());
  expect(new Set(signatures).size).toBe(2);
  expect(
    f.db
      .prepare(
        "SELECT channel_id, status FROM notification_deliveries ORDER BY channel_id",
      )
      .all(),
  ).toEqual([
    { channel_id: "ops", status: "sent" },
    { channel_id: "team", status: "sent" },
  ]);
});

it("aborts in-flight network I/O when Hub closes and leaves the delivery retryable", async () => {
  let received!: () => void;
  const started = new Promise<void>((done) => {
    received = done;
  });
  let requestClosed!: () => void;
  const closed = new Promise<void>((done) => {
    requestClosed = done;
  });
  const base = await serve((_req, res) => {
    res.on("close", requestClosed);
    received();
  });
  const transport = localTransport(base);
  const f = await fixture(transport);
  await f.submit(completed);
  const sending = f.hub.dispatchNotifications();
  await Promise.race([
    started,
    sending.then(() => {
      throw new Error("send ended before reaching server");
    }),
  ]);
  await f.hub.close();
  await sending;
  const signal = transport.mock.calls[0][1]?.signal;
  expect(signal?.aborted).toBe(true);
  expect(signal?.reason).toMatchObject({ name: "AbortError" });
  await closed;
  expect(
    f.db.prepare("SELECT status, attempt FROM notification_deliveries").all(),
  ).toEqual([{ status: "queued", attempt: 1 }]);
});

it("cannot mark a late Feishu receipt sent after the delivery lease expires", async () => {
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let reply!: () => void;
  const release = new Promise<void>((resolve) => {
    reply = resolve;
  });
  const base = await serve(async (_req, res) => {
    arrived();
    await release;
    res.end('{"code":0}');
  });
  const f = await fixture(localTransport(base));
  await f.submit(completed);
  const sending = f.hub.dispatchNotifications();
  try {
    await Promise.race([
      started,
      sending.then(() => {
        throw new Error("request did not reach loopback");
      }),
    ]);
    f.advance(30_000);
  } finally {
    reply();
    await sending;
  }
  expect(
    f.db
      .prepare("SELECT status, attempt, sent_at FROM notification_deliveries")
      .all(),
  ).toEqual([{ status: "claimed", attempt: 1, sent_at: null }]);
  await f.hub.dispatchNotifications();
  expect(
    f.db.prepare("SELECT status, attempt FROM notification_deliveries").all(),
  ).toEqual([{ status: "sent", attempt: 2 }]);
});

it("filters both references from a standalone Worker's plugin import, child and input", async () => {
  const transport = vi.fn<typeof fetch>();
  const f = await fixture(transport);
  expect(
    workerEnvironment(f.cfg, {
      [urlEnv.toLowerCase()]: url,
      [secretEnv]: secret,
      TASKCIRCUIT_HOME: "retain",
    }),
  ).toEqual({ TASKCIRCUIT_HOME: "retain" });
  const trace = join(f.home, "trace.json");
  const names = JSON.stringify([urlEnv, secretEnv]);
  writeFileSync(
    join(f.home, "agent.mjs"),
    [
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const absent = " +
        names +
        ".every(name => process.env[name] === undefined);",
      'export default () => ({manifest:{id:"fixture-agent",kind:"agent",version:"1",apiVersion:1}, async execute(input){',
      "const probe = " +
        JSON.stringify(
          "process.exit(" +
            names +
            ".every(name => process.env[name] === undefined) ? 0 : 1)",
        ) +
        ";",
      'const child = spawnSync(process.execPath, ["-e", probe], {windowsHide: true});',
      "writeFileSync(" +
        JSON.stringify(trace) +
        ", JSON.stringify({ absent, child: child.status, input }));",
      'return {type:"completed",sessionId:"worker-fixture",output:"done"}; }});',
    ].join("\n"),
  );
  f.cfg.plugins = {
    worker: [{ id: "fixture-agent", kind: "agent", module: "./agent.mjs" }],
  };
  f.cfg.agents["demo-agent"].adapter = "fixture-agent";
  const configPath = join(f.home, "taskcircuit.config.json");
  writeFileSync(configPath, JSON.stringify(f.cfg));
  expect(loadConfig(configPath).channels?.team.config).toEqual(config);
  await post(f.hub, "/api/events", {
    source: "local",
    type: "demo.color",
    payload: {},
  });
  const run = promisify(execFile);
  const { stdout, stderr } = await run(
    process.execPath,
    [resolve("dist/cli.js"), "worker", "--once"],
    {
      cwd: f.home,
      windowsHide: true,
      timeout: 5000,
      env: {
        ...process.env,
        TASKCIRCUIT_HOME: f.home,
        TASKCIRCUIT_PORT: new URL(f.base).port,
      },
    },
  );
  const observation = readFileSync(trace, "utf8");
  expect(JSON.parse(observation)).toMatchObject({ absent: true, child: 0 });
  for (const marker of [url, token, secret, urlEnv, secretEnv])
    expect(observation + stdout + stderr).not.toContain(marker);
  expect(transport).not.toHaveBeenCalled();
});
