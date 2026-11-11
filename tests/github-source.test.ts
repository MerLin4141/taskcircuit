// Exercises GitHub protocol handling over the existing loopback listener.
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig, type Config } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { workerEnvironment } from "../src/integrations/environment.js";
import { verifyWebhookSignature } from "../src/integrations/http-webhook.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { resolveCurrentStore } from "../src/storage/generation.js";

const secretEnv = "TASKCIRCUIT_TEST_GITHUB_ALPHA";
const secret = "test-placeholder-github-alpha";
const betaEnv = "TASKCIRCUIT_TEST_GITHUB_BETA";
const betaSecret = "test-placeholder-github-beta";
const issueType = "github.issue.opened";
const commentType = "github.issue_comment.created";

function fixture(name: string) {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/github/" + name + ".json", import.meta.url),
      "utf8",
    ),
  );
}
const opened = () => fixture("issues-opened");
const comment = () => fixture("issue-comment-created");
const digest = (body: string, key = secret) =>
  "sha256=" + createHmac("sha256", key).update(body).digest("hex");

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  vi.stubEnv(secretEnv, secret);
  vi.stubEnv(betaEnv, betaSecret);
  const dir = mkdtempSync(join(tmpdir(), "tc-github-"));
  dirs.push(dir);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const dbPath = await resolveCurrentStore(join(dir, "state"));
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test port unavailable");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));

  const config: Config = {
    ...structuredClone(defaultConfig),
    integrationIngress: { port },
    sources: {
      alpha: {
        type: "github",
        config: {
          secretEnv,
          allowedRepositoryIds: [1001],
          allowedSenderIds: [2001],
        },
      },
      beta: {
        type: "github",
        config: {
          secretEnv: betaEnv,
          allowedRepositoryIds: [1002],
          allowedSenderIds: [2002],
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
        id: "issues",
        event: { source: "alpha", type: issueType },
        automationId: "issue-work",
        agent: "mock-demo",
        title: "Issue",
      },
      {
        id: "comments",
        event: { source: "alpha", type: commentType },
        automationId: "comment-work",
        agent: "mock-demo",
        title: "Comment",
      },
      {
        id: "beta-issues",
        event: { source: "beta", type: issueType },
        agent: "mock-demo",
        title: "Beta issue",
      },
    ],
  };
  const makeHub = () =>
    createHub(dbPath, config, undefined, 0, { dispatcherPollMs: 0 });
  const base = "http://127.0.0.1:" + port;
  function query(sql: string) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  }
  async function post(
    payload: unknown,
    opts: {
      event?: string | null;
      delivery?: string | null;
      instance?: string;
      key?: string;
      signature?: string | null;
      raw?: string;
    } = {},
  ) {
    const body = opts.raw ?? JSON.stringify(payload);
    const headers = new Headers({
      "content-type": "application/json",
      "user-agent": "fixture-client",
      "x-fixture-header": "private-header-marker",
    });
    if (opts.event !== null)
      headers.set("x-github-event", opts.event ?? "issues");
    if (opts.delivery !== null)
      headers.set("x-github-delivery", opts.delivery ?? "delivery-1");
    if (opts.signature !== null)
      headers.set(
        "x-hub-signature-256",
        opts.signature ?? digest(body, opts.key),
      );
    return fetch(base + "/integrations/github/" + (opts.instance ?? "alpha"), {
      method: "POST",
      headers,
      body,
    });
  }
  return { config, base, makeHub, query, post };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function apply(
  hub: ReturnType<Fixture["makeHub"]>,
  issueAutomation = "issue-work",
) {
  const rules = [
    [issueAutomation, issueType],
    ["comment-work", commentType],
  ].map(([name, type]) => ({
    name,
    when: { source: "alpha", type },
    agent: "mock-demo",
    workspace: "safe",
    instruction: "Trusted issue instruction",
    loop: { maxRuns: 3, deadline: "5m" },
  }));
  const res = await hub.inject({
    method: "POST",
    url: "/api/automations/apply",
    payload: {
      dryRun: false,
      document: { schemaVersion: 1, id: "github-fixture", rules },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

it("validates GitHub's documented HMAC test vector without parsing the body", () => {
  const key = Buffer.from("It's a Secret to Everybody");
  const signature =
    "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  expect(
    verifyWebhookSignature(signature, Buffer.from("Hello, World!"), key),
  ).toBe(true);
  expect(
    verifyWebhookSignature(signature, Buffer.from("Hello, World!\n"), key),
  ).toBe(false);
});

it("registers API 2, accepts Issues and comments, and stores only their bounded projection", async () => {
  const f = await setup();
  expect(
    createHubPluginRegistry().getSource("github").manifest.apiVersion,
  ).toBe(2);
  const h = f.makeHub();
  try {
    await h.ready();
    expect((await f.post(opened())).status).toBe(503);
    expect(f.query("SELECT id FROM event_deliveries")).toEqual([]);
    await apply(h);
    const data = opened();
    Object.assign(data, {
      rawMarker: "ignored-body-marker",
      installation: { token: secret },
      type: "chosen-type",
      automationId: "chosen-automation",
      agent: "chosen-agent",
      workspace: "chosen-workspace",
      maxRuns: 900,
      deadline: "100h",
      allowedRoot: "chosen-root",
      capabilities: ["external_action"],
      command: "chosen-command",
      executable: "chosen-executable",
      sourceInstance: "beta",
      trustContext: "trusted_internal",
      plugin: "chosen-plugin",
    });
    const issue = await f.post(data);
    expect(issue.status).toBe(202);
    expect(await issue.json()).toEqual({ status: "accepted" });
    const created = await f.post(comment(), {
      event: "issue_comment",
      delivery: "comment-1",
    });
    expect(created.status).toBe(202);
    const rows = f.query(
      "SELECT type,source_instance,trust_context,correlation_key,payload FROM events ORDER BY rowid",
    );
    expect(
      rows.map(({ type, source_instance, trust_context, correlation_key }) => ({
        type,
        source_instance,
        trust_context,
        correlation_key,
      })),
    ).toEqual(
      [issueType, commentType].map((type) => ({
        type,
        source_instance: "alpha",
        trust_context: "external_untrusted",
        correlation_key: "github:1001:issue:42",
      })),
    );
    const repository = {
      id: 1001,
      fullName: "example/fixture",
      htmlUrl: "https://github.com/example/fixture",
    };
    const author = { id: 2001, login: "fixture-user" };
    const commonIssue = {
      id: 3001,
      number: 42,
      title: "Fixture issue",
      htmlUrl: "https://github.com/example/fixture/issues/42",
    };
    expect(JSON.parse(String(rows[0].payload))).toEqual({
      provider: "github",
      repository,
      sender: author,
      issue: {
        ...commonIssue,
        body: "A synthetic issue body",
        author,
        labels: ["bug"],
      },
    });
    expect(JSON.parse(String(rows[1].payload))).toEqual({
      provider: "github",
      repository,
      sender: author,
      issue: commonIssue,
      comment: {
        id: 4001,
        body: "Fixture comment",
        htmlUrl:
          "https://github.com/example/fixture/issues/42#issuecomment-4001",
        author,
      },
    });
    expect(
      f.query("SELECT source_event_id FROM event_deliveries ORDER BY rowid"),
    ).toEqual([
      { source_event_id: "delivery-1" },
      { source_event_id: "comment-1" },
    ]);
    expect(
      f.query(
        "SELECT definition_id,max_runs FROM automation_roots ORDER BY rowid",
      ),
    ).toEqual([
      { definition_id: "issue-work", max_runs: 3 },
      { definition_id: "comment-work", max_runs: 3 },
    ]);
    const snapshot = JSON.parse(
      String(
        f.query(
          "SELECT config_snapshot_json FROM automation_definition_versions WHERE definition_id='issue-work'",
        )[0].config_snapshot_json,
      ),
    );
    expect(snapshot.policy).toMatchObject({
      sourceInstance: "alpha",
      sourceTrustContext: "external_untrusted",
      agentProfileId: "mock-demo",
      workspaceId: "safe",
      allowedCapabilities: ["read_files"],
    });
    const health = (await h.inject("/api/health")).json();
    expect(health.sources[0]).toMatchObject({
      id: "alpha",
      implementation: "github",
      apiVersion: 2,
      state: "healthy",
    });
    const stored = JSON.stringify([
      rows,
      snapshot,
      health,
      f.query("SELECT * FROM runtime_changes"),
    ]);
    for (const value of [
      secret,
      "private-header-marker",
      "ignored-body-marker",
      secretEnv,
    ])
      expect(stored).not.toContain(value);
    expect(
      workerEnvironment(f.config, {
        [secretEnv]: secret,
        [betaEnv]: betaSecret,
        TASKCIRCUIT_HOME: "kept",
      }),
    ).toEqual({ TASKCIRCUIT_HOME: "kept" });
  } finally {
    await h.close();
  }
});

it("authenticates ping and ignores unselected events, actions and PR conversation comments", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    for (const [event, payload] of [
      ["ping", fixture("ping")],
      ["issues", { ...opened(), action: "closed" }],
      ["issues", { ...opened(), action: "future_action" }],
      ["issue_comment", { ...comment(), action: "edited" }],
      ["issue_comment", fixture("pr-issue-comment-created")],
      ["pull_request", opened()],
      ["workflow_run", {}],
      ["future_event", opened()],
    ] as const) {
      const res = await f.post(payload, { event });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    expect(
      (await f.post(fixture("ping"), { event: "ping", signature: null }))
        .status,
    ).toBe(401);
    expect(
      (
        await f.post(fixture("ping"), {
          event: "ping",
          instance: "beta",
          key: betaSecret,
        })
      ).status,
    ).toBe(403);
    for (const table of ["events", "event_deliveries", "automation_roots"])
      expect(f.query("SELECT id FROM " + table)).toEqual([]);
    expect(h.getSourceHealth().map(({ state }) => state)).toEqual([
      "healthy",
      "healthy",
    ]);
  } finally {
    await h.close();
  }
});

it("checks exact raw bytes first and returns one safe signature error", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    const raw = JSON.stringify(opened(), null, 2);
    for (const signature of [
      null,
      "sha256=broken",
      digest(raw, betaSecret),
      digest(JSON.stringify(opened())),
    ]) {
      const res = await f.post(null, { raw, signature });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "authentication_failed" });
    }
    expect((await f.post(null, { raw: "{", signature: null })).status).toBe(
      401,
    );
    expect((await f.post(null, { raw: "{" })).status).toBe(400);
    await apply(h);
    expect((await f.post(null, { raw })).status).toBe(202);
    expect(h.getSourceHealth()[0].state).toBe("healthy");
  } finally {
    await h.close();
  }
});

it("rejects missing or malformed selected delivery headers and consumed fields", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    for (const opts of [
      { event: null },
      { event: "INVALID!" },
      { delivery: null },
      { delivery: "x".repeat(257) },
    ])
      expect((await f.post(opened(), opts)).status).toBe(400);
    const bad = [
      { ...opened(), repository: { id: "1001", full_name: "example/fixture" } },
      {
        ...opened(),
        repository: { ...opened().repository, full_name: "x".repeat(256) },
      },
      { ...opened(), sender: { id: 0, login: "fixture-user" } },
      { ...opened(), action: null },
      { ...opened(), issue: { ...opened().issue, number: -1 } },
      { ...opened(), issue: { ...opened().issue, user: {} } },
      { ...opened(), issue: { ...opened().issue, body: { unexpected: true } } },
    ];
    for (const payload of bad) expect((await f.post(payload)).status).toBe(400);
    const malformed = comment();
    malformed.comment.body = null;
    expect((await f.post(malformed, { event: "issue_comment" })).status).toBe(
      400,
    );
    expect(f.query("SELECT id FROM event_deliveries")).toEqual([]);
  } finally {
    await h.close();
  }
});

it("authorizes by numeric repository and sender IDs across renames", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    for (const field of ["repository", "sender"]) {
      const payload = opened();
      payload[field].id = 9999;
      const res = await f.post(payload);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
    const renamed = opened();
    renamed.repository.full_name = "example/renamed";
    renamed.sender.login = "renamed-user";
    expect((await f.post(renamed)).status).toBe(202);
    expect(
      JSON.parse(String(f.query("SELECT payload FROM events")[0].payload)),
    ).toMatchObject({
      repository: { id: 1001, fullName: "example/renamed" },
      sender: { id: 2001, login: "renamed-user" },
    });
  } finally {
    await h.close();
  }
});

it("bounds text without splitting UTF-8 and bounds labels while normalizing null Issue body", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    const issue = opened();
    issue.issue.body = "a" + "😀".repeat(9000);
    issue.issue.title = "x".repeat(511) + "😀";
    issue.issue.labels = Array.from({ length: 51 }, (_, i) => ({
      name: "label-" + i,
    }));
    expect((await f.post(issue)).status).toBe(202);
    const note = comment();
    note.comment.body = "😀".repeat(9000);
    expect(
      (await f.post(note, { event: "issue_comment", delivery: "comment-1" }))
        .status,
    ).toBe(202);
    const empty = opened();
    empty.issue.body = null;
    expect((await f.post(empty, { delivery: "null-body" })).status).toBe(202);
    const [a, b, c] = f
      .query("SELECT payload FROM events ORDER BY rowid")
      .map(({ payload }) => JSON.parse(String(payload)));
    expect(a.issue.body).toBe("a" + "😀".repeat(8191));
    expect(a.issue.title).toBe("x".repeat(511));
    expect(a.issue.labels).toHaveLength(50);
    expect(b.comment.body).toBe("😀".repeat(8192));
    expect(c.issue.body).toBe("");
  } finally {
    await h.close();
  }
});

it("budgets JSON-escaped text within the canonical Event size limit", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    const issue = opened();
    issue.issue.body = "\u0001".repeat(18000);
    expect((await f.post(issue)).status).toBe(202);
    const persisted = String(f.query("SELECT payload FROM events")[0].payload);
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(65536);
    expect(JSON.parse(persisted).issue.body.length).toBeLessThan(18000);
  } finally {
    await h.close();
  }
});

it("keeps separate keys, repository allowlists and sender allowlists per instance", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    const opts = { instance: "beta", key: betaSecret };
    expect((await f.post(opened(), { instance: "beta" })).status).toBe(401);
    expect((await f.post(opened(), opts)).status).toBe(403);
    const payload = opened();
    payload.repository.id = 1002;
    expect((await f.post(payload, opts)).status).toBe(403);
    payload.sender.id = 2002;
    expect((await f.post(payload, opts)).status).toBe(202);
    expect(
      f.query("SELECT source_instance,correlation_key FROM events"),
    ).toEqual([
      { source_instance: "beta", correlation_key: "github:1002:issue:42" },
    ]);
  } finally {
    await h.close();
  }
});

it("deduplicates and conflicts across restart and keeps original routing after a route change", async () => {
  const f = await setup();
  let h = f.makeHub();
  try {
    await h.ready();
    await apply(h);
    expect((await f.post(opened())).status).toBe(202);
    expect((await f.post(opened())).status).toBe(200);
    const projected = opened();
    projected.issue.title = "Changed fixture title";
    expect((await f.post(projected)).status).toBe(409);
    const roots = f.query("SELECT id,definition_id FROM automation_roots");
    await h.close();
    f.config.routes.find((r) => r.id === "issues")!.automationId =
      "new-issue-work";
    h = f.makeHub();
    await h.ready();
    await apply(h, "new-issue-work");
    expect((await f.post(opened())).status).toBe(200);
    const conflict = await f.post(projected);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "delivery_conflict" });
    expect(f.query("SELECT id,definition_id FROM automation_roots")).toEqual(
      roots,
    );
    expect(f.query("SELECT id FROM event_deliveries")).toHaveLength(1);
    expect(
      JSON.parse(String(f.query("SELECT payload FROM events")[0].payload)).issue
        .title,
    ).toBe("Fixture issue");
  } finally {
    await h.close();
  }
});

it("serves exact GitHub instance paths on ingress without changing local event intake", async () => {
  const f = await setup();
  const h = f.makeHub();
  try {
    await h.ready();
    for (const path of [
      "/api/roots",
      "/integrations/github/alpha/",
      "/integrations/github/missing",
    ])
      expect((await fetch(f.base + path, { method: "POST" })).status).toBe(404);
    expect((await fetch(f.base + "/api/state")).status).toBe(404);
    expect((await fetch(f.base + "/integrations/github/alpha")).status).toBe(
      404,
    );
    const local = await h.inject({
      method: "POST",
      url: "/api/events/v2",
      payload: {
        sourceEventId: "local-fixture",
        type: "demo.loop",
        payload: {},
      },
    });
    expect(local.statusCode).toBe(200);
    expect(f.query("SELECT source_instance FROM events")).toEqual([
      { source_instance: "local-cli" },
    ]);
  } finally {
    await h.close();
  }
});

it.each([
  ["allowedRepositoryIds", []],
  ["allowedRepositoryIds", [1001, 1001]],
  ["allowedRepositoryIds", [Number.MAX_SAFE_INTEGER + 1]],
  ["allowedRepositoryIds", Array.from({ length: 101 }, (_, i) => i + 1)],
  ["allowedSenderIds", []],
  ["allowedSenderIds", ["2001"]],
  ["allowedSenderIds", [2001, 2001]],
  ["allowedSenderIds", [-1]],
])("rejects invalid mandatory %s at startup", async (field, value) => {
  const f = await setup();
  f.config.sources!.alpha.config![String(field)] = value;
  const h = f.makeHub();
  try {
    await expect(h.ready()).rejects.toThrow("source_start_failed: alpha");
  } finally {
    await h.close();
  }
});
