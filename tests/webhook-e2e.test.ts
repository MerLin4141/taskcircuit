// Exercises the real loopback listener and durable intake, including failures before and after commit.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createHub } from "../src/hub.js";
import { defaultConfig, type Config } from "../src/config.js";
import { workerEnvironment } from "../src/integrations/environment.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { workOnce } from "../src/worker.js";
import { resolveCurrentStore } from "../src/storage/generation.js";

const alpha = "test-placeholder-alpha";
const beta = "test-placeholder-beta";
const secretEnv = "TASKCIRCUIT_TEST_WEBHOOK_ALPHA";
const body = '{ "taskId": "subject", "text": "hello" }';
const signature = (raw: string | Buffer, secret = alpha) =>
  "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test port unavailable");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function setup() {
  vi.stubEnv(secretEnv, alpha);
  vi.stubEnv("TASKCIRCUIT_TEST_WEBHOOK_BETA", beta);
  const dir = mkdtempSync(join(tmpdir(), "tc-webhook-"));
  dirs.push(dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const home = join(dir, "state");
  const dbPath = await resolveCurrentStore(home);
  const ingressPort = await port();
  const config: Config = {
    ...structuredClone(defaultConfig),
    integrationIngress: { port: ingressPort },
    sources: {
      alpha: {
        type: "webhook",
        config: {
          secretEnv,
          eventType: "webhook.task",
          correlationField: "taskId",
        },
      },
      beta: {
        type: "webhook",
        config: {
          secretEnv: "TASKCIRCUIT_TEST_WEBHOOK_BETA",
          eventType: "webhook.build",
          deliveryHeader: "X-Custom-Delivery",
        },
      },
    },
    policyWorkspaces: {
      safe: {
        path: workspace,
        allowedRoot: dir,
        allowedCapabilities: ["read_files"],
      },
    },
    routes: [
      ...defaultConfig.routes,
      {
        id: "alpha-route",
        event: { source: "alpha", type: "webhook.task" },
        agent: "mock-demo",
        title: "Task",
        automationId: "managed",
      },
      {
        id: "beta-route",
        event: { source: "beta", type: "webhook.build" },
        agent: "mock-demo",
        title: "Build",
      },
    ],
  };
  const requestUrl = "http://127.0.0.1:" + ingressPort;
  const makeHub = (
    registry = createHubPluginRegistry(),
    managementPort?: number,
  ) =>
    createHub(
      dbPath,
      config,
      undefined,
      0,
      { dispatcherPollMs: 0, managementPort },
      {
        registry,
        sourceId: "local",
      },
    );
  return {
    config,
    dir,
    workspace,
    home,
    dbPath,
    ingressPort,
    requestUrl,
    makeHub,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
function rule(name = "managed", source = "alpha", agent = "mock-demo") {
  return {
    schemaVersion: 1,
    id: "test-document",
    rules: [
      {
        name,
        when: { source, type: "webhook.task" },
        agent,
        workspace: "safe",
        instruction: "trusted instruction",
        loop: { maxRuns: 3, deadline: "5m" },
      },
    ],
  };
}

async function apply(hub: ReturnType<Fixture["makeHub"]>, document = rule()) {
  const res = await hub.inject({
    method: "POST",
    url: "/api/automations/apply",
    payload: { document, dryRun: false },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().summary.create).toBe(1);
}

function eventHeaders(raw: string | Buffer, id = "delivery-1", secret = alpha) {
  return {
    "content-type": "application/json",
    "x-taskcircuit-delivery": id,
    "x-taskcircuit-signature-256": signature(raw, secret),
  };
}

async function post(
  f: Fixture,
  raw = body,
  id = "delivery-1",
  name = "alpha",
  secret = alpha,
  extra: Record<string, string> = {},
) {
  return fetch(f.requestUrl + "/integrations/webhook/" + name, {
    method: "POST",
    body: raw,
    headers: { ...eventHeaders(raw, id, secret), ...extra },
  });
}

function query(f: Fixture, sql: string) {
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function sendChunks(
  url: string,
  chunks: string[],
  headers: Record<string, string>,
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk: string) => {
        body += chunk;
      });
      res.once("end", () => resolve({ status: res.statusCode!, body }));
      res.once("error", reject);
    });
    req.once("error", reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

it("waits for an applied binding and commits the host-owned identity and routing", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    expect((await post(f)).status).toBe(503);
    expect(query(f, "SELECT id FROM event_deliveries")).toEqual([]);
    for (const document of [
      rule("wrong-name"),
      rule("managed", "webhook"),
      rule("managed", "alpha", "demo-agent"),
    ]) {
      expect(
        (
          await h.inject({
            method: "POST",
            url: "/api/automations/apply",
            payload: { document, dryRun: false },
          })
        ).statusCode,
      ).toBe(400);
    }
    await apply(h);
    const spoofed = {
      taskId: "subject",
      type: "wrong",
      sourceInstance: "beta",
      trustContext: "trusted_internal",
      automationId: "wrong",
      agent: "wrong",
      workspace: "wrong",
      allowedRoot: "wrong",
      capabilities: ["external_action"],
      maxRuns: 999,
      deadline: "999h",
      executable: "wrong",
      command: "wrong",
      plugin: "wrong",
    };
    const res = await post(f, JSON.stringify(spoofed));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "accepted" });
    const [persisted] = query(f, "SELECT * FROM events");
    expect(persisted).toMatchObject({
      source_instance: "alpha",
      trust_context: "external_untrusted",
      type: "webhook.task",
      correlation_key: "subject",
    });
    expect(JSON.parse(String(persisted.payload))).toEqual(spoofed);
    expect(
      query(
        f,
        "SELECT definition_id,max_runs,subject_key FROM automation_roots",
      ),
    ).toEqual([
      { definition_id: "managed", max_runs: 3, subject_key: "subject" },
    ]);
    const [version] = query(
      f,
      "SELECT config_snapshot_json FROM automation_definition_versions WHERE definition_id='managed'",
    );
    expect(
      JSON.parse(String(version.config_snapshot_json)).policy,
    ).toMatchObject({
      sourceInstance: "alpha",
      sourceTrustContext: "external_untrusted",
      agentProfileId: "mock-demo",
      workspacePath: f.workspace,
      allowedCapabilities: ["read_files"],
    });
    const leaked = JSON.stringify([
      query(f, "SELECT * FROM events"),
      query(f, "SELECT * FROM automation_roots"),
      query(f, "SELECT * FROM automation_definition_versions"),
      query(f, "SELECT * FROM runtime_changes"),
      (await h.inject("/api/health")).json(),
    ]);
    expect(leaked).not.toContain(alpha);
    const credentialBody = JSON.stringify({ text: alpha });
    const credential = await post(f, credentialBody, "credential");
    expect(credential.status).toBe(400);
    expect(await credential.text()).not.toContain(alpha);
    expect(query(f, "SELECT id FROM events")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

it("uses separate instance paths, secrets, event types and delivery namespaces", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    expect((await post(f)).status).toBe(202);
    const custom = { "x-custom-delivery": "delivery-1" };
    expect(
      (await post(f, body, "delivery-1", "beta", alpha, custom)).status,
    ).toBe(401);
    const other = await post(f, body, "delivery-1", "beta", beta, custom);
    expect(other.status).toBe(202);
    expect(await other.json()).toEqual({ status: "unroutable" });
    expect((await post(f, body, "delivery-2")).status).toBe(202);
    const duplicate = await post(f);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ status: "duplicate" });
    expect(
      query(f, "SELECT source_instance,type FROM events ORDER BY rowid"),
    ).toEqual([
      { source_instance: "alpha", type: "webhook.task" },
      { source_instance: "beta", type: "webhook.build" },
      { source_instance: "alpha", type: "webhook.task" },
    ]);
    expect(query(f, "SELECT id FROM event_deliveries")).toHaveLength(3);
  } finally {
    await h.close();
  }
});

it("authenticates exact raw bytes before parsing and gives uniform auth failures", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    const url = f.requestUrl + "/integrations/webhook/alpha";
    const missing = await fetch(url, {
      method: "POST",
      body: "{",
      headers: {
        "content-type": "application/json",
        "x-taskcircuit-delivery": "missing",
      },
    });
    expect(missing.status).toBe(401);
    const error = await missing.json();
    for (const invalid of [
      "invalid",
      signature(body, beta),
      signature('{"taskId":"subject","text":"hello"}'),
    ]) {
      const res = await post(f, body, "auth", "alpha", alpha, {
        "x-taskcircuit-signature-256": invalid,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(error);
    }
    const signedBrokenJson = await post(f, "{");
    expect(signedBrokenJson.status).toBe(400);
    for (const raw of ["null", "[]", "7", '"text"', '{"taskId":false}'])
      expect((await post(f, raw)).status).toBe(400);
    const noId = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-taskcircuit-signature-256": signature(body),
      },
    });
    expect(noId.status).toBe(400);
    expect((await post(f, body, "x".repeat(257))).status).toBe(400);
    expect(
      (
        await post(f, body, "good", "alpha", alpha, {
          "content-type": "application/json; charset=UTF-8",
          "content-encoding": "identity",
          "x-taskcircuit-signature-256":
            "sha256=" + signature(body).slice(7).toUpperCase(),
        })
      ).status,
    ).toBe(202);
    expect(query(f, "SELECT id FROM event_deliveries")).toHaveLength(1);
    expect(
      (await h.inject("/api/health"))
        .json()
        .sources.every(
          (source: { state: string }) => source.state === "healthy",
        ),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

it("rejects unsupported media and encoding and enforces both body limits", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    expect(
      (
        await post(f, body, "text", "alpha", alpha, {
          "content-type": "text/plain",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await post(f, body, "gzip", "alpha", alpha, {
          "content-encoding": "gzip",
        })
      ).status,
    ).toBe(415);
    const chunks = ['{"text":"' + "x".repeat(80000), "y".repeat(60000) + '"}'];
    const res = await sendChunks(
      f.requestUrl + "/integrations/webhook/alpha",
      chunks,
      eventHeaders(chunks.join(""), "chunked"),
    );
    expect(res.status).toBe(413);
    expect(
      (await post(f, JSON.stringify({ text: "x".repeat(65536) }), "canonical"))
        .status,
    ).toBe(413);
    expect(query(f, "SELECT id FROM event_deliveries")).toEqual([]);
  } finally {
    await h.close();
  }
});

it("offers only exact POST instance paths on ingress and keeps the local event path", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    for (const [path, method] of [
      ["/api/state", "GET"],
      ["/api/roots", "GET"],
      ["/api/events/v2", "POST"],
      ["/integrations/webhook/alpha?query=1", "POST"],
      ["/integrations/webhook/alpha/", "POST"],
      ["/integrations/webhook/unknown", "POST"],
      ...["GET", "PUT", "PATCH", "DELETE"].map((method) => [
        "/integrations/webhook/alpha",
        method,
      ]),
    ])
      expect((await fetch(f.requestUrl + path, { method })).status).toBe(404);
    expect(
      (
        await h.inject({
          method: "POST",
          url: "/api/events/v2",
          payload: { sourceEventId: "local", type: "demo.loop", payload: {} },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      query(f, "SELECT source_instance,trust_context FROM events"),
    ).toEqual([
      { source_instance: "local-cli", trust_context: "trusted_local_cli" },
    ]);
  } finally {
    await h.close();
  }
});

it("deduplicates after a committed response is dropped before it reaches the sender", async () => {
  const f = await setup();
  const h = createHub(f.dbPath, f.config, undefined, 20, {
    dispatcherPollMs: 0,
  });
  const proxy = createServer((sender) => {
    const upstream = connect(f.ingressPort, "127.0.0.1");
    sender.on("error", () => upstream.destroy());
    upstream.on("error", () => sender.destroy());
    sender.pipe(upstream);
    upstream.once("data", () => {
      sender.destroy();
      upstream.destroy();
    });
    sender.once("close", () => upstream.destroy());
  });
  try {
    const base = await h.listen({ host: "127.0.0.1", port: 0 });
    await apply(h);
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const addr = proxy.address();
    if (!addr || typeof addr === "string") throw new Error("proxy unavailable");
    await expect(
      sendChunks(
        "http://127.0.0.1:" + addr.port + "/integrations/webhook/alpha",
        [body],
        eventHeaders(body, "lost"),
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(query(f, "SELECT id FROM event_deliveries")).toHaveLength(1);
    const retry = await post(f, body, "lost");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ status: "duplicate" });
    expect(query(f, "SELECT id FROM event_deliveries")).toHaveLength(1);
    expect(query(f, "SELECT id FROM automation_roots")).toHaveLength(1);
    await vi.waitFor(() =>
      expect(query(f, "SELECT id FROM work_items")).toHaveLength(1),
    );
    const execute = vi.fn(async () => ({
      type: "completed" as const,
      sessionId: "fixture-session",
      output: "done",
    }));
    expect(await workOnce(base, "webhook-fixture", { execute })).toBe(true);
    expect(await workOnce(base, "webhook-fixture", { execute })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await new Promise<void>((done) => proxy.close(() => done()));
    await h.close();
  }
});

it("preserves replay authority across restart, route change and a disabled original definition", async () => {
  const f = await setup();
  let h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    expect((await post(f)).status).toBe(202);
    const before = query(f, "SELECT id,definition_id FROM automation_roots");
    await h.close();
    const db = new DatabaseSync(f.dbPath);
    try {
      db.exec(
        "UPDATE automation_definitions SET status='disabled' WHERE id='managed'",
      );
    } finally {
      db.close();
    }
    f.config.routes.find((r) => r.id === "alpha-route")!.automationId = "other";
    h = f.makeHub();
    await h.ready();
    await apply(h, rule("other"));
    expect((await post(f)).status).toBe(200);
    const conflict = await post(f, '{"text":"changed"}');
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "delivery_conflict" });
    expect(query(f, "SELECT id,definition_id FROM automation_roots")).toEqual(
      before,
    );
    expect(query(f, "SELECT payload FROM events")).toHaveLength(1);
    expect(
      JSON.parse(String(query(f, "SELECT payload FROM events")[0].payload)),
    ).toEqual(JSON.parse(body));
  } finally {
    await h.close();
  }
});

it("returns 503 under SQLite write contention without accepting a partial delivery", async () => {
  const f = await setup();
  const h = f.makeHub();
  const lock = new DatabaseSync(f.dbPath);
  try {
    await h.ready();
    await apply(h);
    lock.exec("BEGIN IMMEDIATE");
    try {
      const start = performance.now();
      expect((await post(f)).status).toBe(503);
      expect(performance.now() - start).toBeLessThan(2000);
      expect(query(f, "SELECT id FROM event_deliveries")).toEqual([]);
      expect(query(f, "SELECT id FROM automation_roots")).toEqual([]);
    } finally {
      lock.exec("ROLLBACK");
    }
    expect((await post(f)).status).toBe(202);
  } finally {
    lock.close();
    await h.close();
  }
});

function holdBody(f: Fixture) {
  const held = request(f.requestUrl + "/integrations/webhook/alpha", {
    method: "POST",
    headers: {
      ...eventHeaders(body, "held"),
      "content-length": String(Buffer.byteLength(body)),
      expect: "100-continue",
    },
  });
  held.on("error", () => {});
  const admitted = once(held, "continue");
  held.flushHeaders();
  return { held, admitted };
}

it("bounds concurrency and rejects new requests during shutdown", async () => {
  const f = await setup();
  f.config.integrationIngress!.maxConcurrent = 1;
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    const { held, admitted } = holdBody(f);
    try {
      await admitted;
      expect((await post(f)).status).toBe(503);
      const response = once(held, "response");
      held.end(body);
      const [accepted] = await response;
      expect(accepted.statusCode).toBe(202);
      accepted.resume();
    } finally {
      held.destroy();
    }
    const pending = holdBody(f);
    try {
      await pending.admitted;
      const stopped = h.stopSources();
      expect((await post(f)).status).toBe(503);
      await stopped;
    } finally {
      pending.held.destroy();
    }
  } finally {
    await h.close();
  }
});

it("leaves ingress closed during readiness, then admits when every required Source starts", async () => {
  const f = await setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registry = createHubPluginRegistry();
  registry.register({
    manifest: { kind: "source", id: "slow", apiVersion: 2, version: "1" },
    createSource: () => ({
      async start() {
        entered.resolve();
        await release.promise;
      },
    }),
  });
  f.config.sources!.slow = { type: "slow" };
  const h = f.makeHub(registry);
  const ready = h.ready();
  try {
    await entered.promise;
    expect((await post(f)).status).toBe(503);
    release.resolve();
    await ready;
    await apply(h);
    expect((await post(f)).status).toBe(202);
  } finally {
    release.resolve();
    await h.close();
  }
});

it("blocks readiness on listener failure and closes the listener on partial Source startup failure", async () => {
  const f = await setup();
  expect(() => f.makeHub(createHubPluginRegistry(), f.ingressPort)).toThrow(
    "integration_ingress_port_collision",
  );
  const occupied = createServer();
  await new Promise<void>((done) =>
    occupied.listen(f.ingressPort, "127.0.0.1", done),
  );
  let h = f.makeHub();
  try {
    await expect(h.ready()).rejects.toThrow("integration_listen_failed");
  } finally {
    await h.close();
    await new Promise<void>((done) => occupied.close(() => done()));
  }
  f.config.sources!.beta.config!.secretEnv = "TASKCIRCUIT_TEST_WEBHOOK_MISSING";
  vi.stubEnv("TASKCIRCUIT_TEST_WEBHOOK_MISSING", undefined);
  h = f.makeHub();
  try {
    await expect(h.ready()).rejects.toThrow("source_start_failed: beta");
    expect(h.getSourceHealth().map(({ state }) => state)).toEqual([
      "stopped",
      "failed",
    ]);
    await expect(post(f)).rejects.toBeInstanceOf(Error);
  } finally {
    await h.close();
  }
});

it("keeps v0.3 config unchanged and does not bind unused integration ingress", async () => {
  const f = await setup();
  delete f.config.sources;
  f.config.routes = structuredClone(defaultConfig.routes);
  let h = f.makeHub();
  try {
    await h.ready();
    await expect(post(f)).rejects.toBeInstanceOf(Error);
    expect((await h.inject("/api/health")).json()).toEqual({
      ok: true,
      service: "taskcircuit",
    });
  } finally {
    await h.close();
  }
  delete f.config.integrationIngress;
  h = f.makeHub();
  try {
    expect((await h.inject("/api/health")).json()).toEqual({
      ok: true,
      service: "taskcircuit",
    });
  } finally {
    await h.close();
  }
});

it("scrubs Hub secrets before Worker plugin import and keeps them out of Agent input and children", async () => {
  const f = await setup();
  expect(
    workerEnvironment(f.config, {
      [secretEnv.toLowerCase()]: alpha,
      TASKCIRCUIT_HOME: "retained",
    }),
  ).toEqual({ TASKCIRCUIT_HOME: "retained" });
  const trace = join(f.dir, "worker-trace.txt");
  writeFileSync(
    join(f.dir, "agent.mjs"),
    [
      'import { spawnSync } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      "const name = " + JSON.stringify(secretEnv) + ";",
      "const absent = process.env[name] === undefined;",
      'export default () => ({ manifest: { id: "fixture-agent", apiVersion: 1, kind: "agent", version: "1" }, async execute(input) {',
      'const child = spawnSync(process.execPath, ["-e", "process.exit(process.env[" + JSON.stringify(name) + "] === undefined ? 0 : 1)"], { windowsHide: true });',
      "writeFileSync(" +
        JSON.stringify(trace) +
        ", JSON.stringify({ absent, child: child.status, input }));",
      'return { type: "completed", sessionId: "fixture", output: "done" }; } });',
    ].join("\n"),
  );
  f.config.plugins = {
    worker: [{ id: "fixture-agent", kind: "agent", module: "./agent.mjs" }],
  };
  f.config.agents.fixture = {
    adapter: "fixture-agent",
    isolation: "trusted-local",
  };
  f.config.routes.find((r) => r.id === "alpha-route")!.agent = "fixture";
  writeFileSync(
    join(f.dir, "taskcircuit.config.json"),
    JSON.stringify(f.config),
  );
  const h = createHub(f.dbPath, f.config, undefined, 20, {
    dispatcherPollMs: 0,
  });
  try {
    const base = await h.listen({ host: "127.0.0.1", port: 0 });
    await apply(h, rule("managed", "alpha", "fixture"));
    expect((await post(f)).status).toBe(202);
    await vi.waitFor(() =>
      expect(query(f, "SELECT id FROM work_items")).toHaveLength(1),
    );
    const child = spawn(
      process.execPath,
      [resolve("dist/cli.js"), "worker", "--once"],
      {
        cwd: f.dir,
        windowsHide: true,
        env: {
          ...process.env,
          TASKCIRCUIT_HOME: f.home,
          TASKCIRCUIT_PORT: new URL(base).port,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
    const guard = setTimeout(() => child.kill(), 5000);
    try {
      const [code] = await once(child, "close");
      expect(code, output).toBe(0);
      expect(output).not.toContain(alpha);
    } finally {
      clearTimeout(guard);
    }
    const observation = readFileSync(trace, "utf8");
    expect(observation).not.toContain(alpha);
    expect(observation).not.toContain(secretEnv);
    expect(JSON.parse(observation)).toMatchObject({
      absent: true,
      child: 0,
      input: {
        instruction: "trusted instruction",
        workingDirectory: f.workspace,
      },
    });
    expect(query(f, "SELECT status FROM work_items")).toEqual([
      { status: "completed" },
    ]);
  } finally {
    await h.close();
  }
}, 8000);

it("reports an unavailable optional instance while keeping its exact path reserved", async () => {
  const f = await setup();
  f.config.sources!.beta.required = false;
  f.config.sources!.beta.config!.secretEnv = "TASKCIRCUIT_TEST_WEBHOOK_MISSING";
  vi.stubEnv("TASKCIRCUIT_TEST_WEBHOOK_MISSING", undefined);
  const h = f.makeHub();
  try {
    await h.ready();
    expect((await post(f, body, "optional", "beta", beta)).status).toBe(503);
    expect((await h.inject("/api/health")).json().sources[1]).toMatchObject({
      state: "failed",
    });
    await apply(h);
    expect((await post(f)).status).toBe(202);
  } finally {
    await h.close();
  }
});
