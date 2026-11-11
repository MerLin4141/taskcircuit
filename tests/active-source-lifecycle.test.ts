// Protects the API compatibility boundary, per-instance authority, and cleanup after partial startup.
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { formatDoctor } from "../src/cli-format.js";
import { createDefinition } from "../src/automation-domain.js";
import { defaultConfig, loadConfig, type Config } from "../src/config.js";
import { createHub } from "../src/hub.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { loadTrustedPlugins } from "../src/plugins/loader.js";
import type { SourceHost, SourcePluginV2 } from "../src/plugins/types.js";
import { resolveCurrentStore } from "../src/storage/generation.js";

const dirs: string[] = [];
function temporaryDir() {
  const dir = mkdtempSync(join(tmpdir(), "tc-active-source-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function config(ids = ["alpha", "beta"]): Config {
  return {
    ...defaultConfig,
    sources: Object.fromEntries(
      ids.map((id) => [id, { type: "fixture-source", config: { label: id } }]),
    ),
    routes: [
      ...defaultConfig.routes,
      ...ids.map((id) => ({
        id,
        event: { source: id, type: "fixture.event" },
        agent: "mock-demo",
        title: id,
      })),
    ],
  };
}

function event(id = "delivery-1") {
  return {
    sourceEventId: id,
    type: "fixture.event",
    payload: { text: "fixture" },
  };
}

function fixture(
  options: {
    start?: (id: string) => Promise<void>;
    failStart?: string;
    failStop?: string;
    hangStop?: string;
  } = {},
) {
  const hosts = new Map<string, SourceHost>();
  const calls: string[] = [];
  const registry = createHubPluginRegistry();
  const plugin: SourcePluginV2 = {
    manifest: {
      id: "fixture-source",
      kind: "source",
      apiVersion: 2,
      version: "1",
    },
    createSource(settings, host) {
      const id = String(settings.label);
      hosts.set(id, host);
      return {
        async start(signal) {
          calls.push("start:" + id);
          signal.addEventListener("abort", () => calls.push("abort:" + id), {
            once: true,
          });
          await options.start?.(id);
          if (options.failStart === id)
            throw new Error("private startup detail");
        },
        async stop() {
          calls.push("stop:" + id);
          if (options.failStop === id)
            throw new Error("private shutdown detail");
          if (options.hangStop === id) await new Promise(() => {});
        },
      };
    },
  };
  registry.register(plugin);
  const makeHub = (settings = config(), path = ":memory:") =>
    createHub(
      path,
      settings,
      undefined,
      0,
      { dispatcherPollMs: 0 },
      {
        registry,
        sourceId: "local",
      },
    );
  return { hosts, calls, makeHub };
}

it("loads unchanged passive Source API 1 and active Source API 2 modules together", async () => {
  const dir = temporaryDir();
  writeFileSync(
    join(dir, "legacy.mjs"),
    'export default () => ({manifest:{id:"legacy",kind:"source",apiVersion:1,version:"1"},ingest(input){return input}})',
  );
  const registry = createHubPluginRegistry();
  await loadTrustedPlugins(
    registry,
    join(dir, "config.json"),
    [
      { id: "legacy", kind: "source", module: "./legacy.mjs" },
      {
        id: "fixture-source",
        kind: "source",
        module: resolve("tests/fixtures/active-source.mjs"),
      },
    ],
    "hub",
  );
  expect(registry.getSource("legacy").manifest.apiVersion).toBe(1);
  expect(registry.getSource("fixture-source").manifest.apiVersion).toBe(2);
});

it.each([
  ["source", 3, "hub"],
  ["agent", 2, "worker"],
  ["channel", 3, "hub"],
] as const)(
  "rejects %s API %d before registration",
  async (kind, apiVersion, processKind) => {
    const dir = temporaryDir();
    writeFileSync(
      join(dir, "invalid.mjs"),
      "export default () => ({manifest:" +
        JSON.stringify({
          id: "invalid",
          kind,
          apiVersion,
          version: "1",
        }) +
        ", ingest(){}, createSource(){}, execute(){}, createChannel(){}})",
    );
    const registry = createHubPluginRegistry();
    await expect(
      loadTrustedPlugins(
        registry,
        join(dir, "config.json"),
        [{ id: "invalid", kind, module: "./invalid.mjs" }],
        processKind,
      ),
    ).rejects.toMatchObject({ code: "plugin_api_incompatible" });
  },
);

it("rejects a route that uses an implementation ID instead of a configured instance", () => {
  const dir = temporaryDir();
  const settings = config(["alpha"]);
  settings.routes.at(-1)!.event.source = "fixture-source";
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(settings));
  expect(() => loadConfig(path)).toThrow("source_route_instance_unknown");
});

it("rejects an API 1 Source in an active instance slot", () => {
  const settings = config(["alpha"]);
  settings.sources!.alpha.type = "local";
  expect(() => fixture().makeHub(settings)).toThrow(
    "source_instance_requires_api_2",
  );
});

it("keeps a v0.3 config without sources and the local API 1 route working", async () => {
  const dir = temporaryDir();
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(defaultConfig));
  const h = fixture().makeHub(loadConfig(path));
  try {
    const res = await h.inject({
      method: "POST",
      url: "/api/events/v2",
      payload: {
        ...event(),
        type: "demo.loop",
      },
    });
    const details = (
      await h.inject("/api/events/v2/" + res.json().eventId)
    ).json();
    expect(details.event).toMatchObject({
      sourceInstance: "local-cli",
      trustContext: "trusted_local_cli",
    });
  } finally {
    await h.close();
  }
});

it("creates separate instances, binds identity, and deduplicates per instance", async () => {
  const f = fixture();
  const h = f.makeHub();
  try {
    await h.ready();
    expect(f.calls).toEqual(["start:alpha", "start:beta"]);
    const alpha = f.hosts.get("alpha")!;
    const beta = f.hosts.get("beta")!;
    const first = await alpha.submit(event());
    const same = await alpha.submit(event());
    const other = await beta.submit(event());
    expect(first.status).toBe("unroutable");
    expect(same).toEqual({ status: "duplicate", eventId: first.eventId });
    expect(other.eventId).not.toBe(first.eventId);
    for (const [id, result] of [
      ["alpha", first],
      ["beta", other],
    ] as const) {
      const details = (
        await h.inject("/api/events/v2/" + result.eventId)
      ).json();
      expect(details.event).toMatchObject({
        sourceInstance: id,
        trustContext: "external_untrusted",
      });
    }
    expect(
      await alpha.submit({ ...event(), payload: { text: "changed" } }),
    ).toEqual({ status: "conflict", eventId: first.eventId });
    expect(
      (
        await h.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "alpha", type: "fixture.event", payload: {} },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await h.close();
  }
});

it("accepts only the submission fields and exposes only submission and health", async () => {
  const f = fixture();
  const h = f.makeHub(config(["alpha"]));
  try {
    await h.ready();
    const host = f.hosts.get("alpha")!;
    expect(Object.keys(host).sort()).toEqual(["reportHealth", "submit"]);
    for (const key of [
      "sourceInstance",
      "trustContext",
      "automationId",
      "automationIds",
      "parentEventId",
      "agent",
      "workspace",
      "capabilities",
      "maxRuns",
      "deadline",
      "module",
      "executable",
    ]) {
      await expect(
        host.submit({ ...event(), [key]: "fixture" }),
      ).rejects.toMatchObject({ code: "source_event_invalid" });
    }
    await expect(
      host.submit({ ...event(), type: "demo.loop" }),
    ).rejects.toMatchObject({ code: "source_event_type_unconfigured" });
    expect((await h.inject("/api/events/v2")).json()).toEqual([]);
  } finally {
    await h.close();
  }
});

it("uses the trusted Automation binding and replays the original route across restart", async () => {
  const dir = temporaryDir();
  const path = await resolveCurrentStore(join(dir, "state"));
  const f = fixture();
  const settings = config(["alpha"]);
  settings.routes.at(-1)!.automationId = "managed";
  const h = f.makeHub(settings, path);
  let eventId = "";
  try {
    await h.ready();
    const host = f.hosts.get("alpha")!;
    await expect(host.submit(event())).rejects.toMatchObject({
      code: "source_route_unavailable",
    });
    const db = new DatabaseSync(path);
    try {
      createDefinition(
        db,
        "managed",
        "managed",
        {
          policy: {
            sourceInstance: "alpha",
            sourceTrustContext: "external_untrusted",
            agentProfileId: "mock-demo",
            eventTypes: ["fixture.event"],
          },
        },
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }
    const first = await host.submit({
      ...event(),
      payload: { automationId: "ignored", workspace: "ignored" },
    });
    expect(first.status).toBe("accepted");
    eventId = first.eventId;
    const roots = (await h.inject("/api/roots")).json();
    expect(roots).toHaveLength(1);
    expect(roots[0].automation).toBe("managed");
  } finally {
    await h.close();
  }
  const next = fixture();
  const reopened = next.makeHub(config(["alpha"]), path);
  try {
    await reopened.ready();
    expect(
      await next.hosts.get("alpha")!.submit({
        ...event(),
        payload: { automationId: "ignored", workspace: "ignored" },
      }),
    ).toEqual({ status: "duplicate", eventId });
    expect((await reopened.inject("/api/roots")).json()).toHaveLength(1);
  } finally {
    await reopened.close();
  }
});

it("holds readiness and submissions until every required Source is ready", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = fixture({
    async start(id) {
      if (id === "beta") {
        entered.resolve();
        await release.promise;
      }
    },
  });
  const h = f.makeHub();
  let ready = false;
  const started = h.ready().then(() => {
    ready = true;
  });
  try {
    await entered.promise;
    expect(ready).toBe(false);
    expect(h.getSourceHealth().map(({ state }) => state)).toEqual([
      "healthy",
      "starting",
    ]);
    await expect(f.hosts.get("alpha")!.submit(event())).rejects.toMatchObject({
      code: "source_unavailable",
    });
    release.resolve();
    await started;
    expect(ready).toBe(true);
  } finally {
    release.resolve();
    await h.close();
  }
});

it("rolls back both started and partially initialized Sources on required startup failure", async () => {
  const f = fixture({ failStart: "beta" });
  const h = f.makeHub();
  try {
    await expect(h.ready()).rejects.toThrow("source_start_failed: beta");
    expect(f.calls).toEqual([
      "start:alpha",
      "start:beta",
      "abort:alpha",
      "abort:beta",
      "stop:alpha",
      "stop:beta",
    ]);
    await expect(f.hosts.get("alpha")!.submit(event())).rejects.toMatchObject({
      code: "source_unavailable",
    });
  } finally {
    await h.close();
  }
});

it("isolates optional startup failures and reports sanitized health", async () => {
  const f = fixture({ failStart: "alpha" });
  const settings = config();
  settings.sources!.alpha.required = false;
  const h = f.makeHub(settings);
  try {
    const health = (await h.inject("/api/health")).json();
    expect(health.sources).toEqual([
      {
        id: "alpha",
        implementation: "fixture-source",
        apiVersion: 2,
        state: "failed",
        reason: "startup_failed",
      },
      {
        id: "beta",
        implementation: "fixture-source",
        apiVersion: 2,
        state: "healthy",
      },
    ]);
    expect(f.calls).toContain("stop:alpha");
    expect(formatDoctor({ hub: { status: "PASS", detail: health } })).toContain(
      "Source alpha · fixture-source · API 2 · failed",
    );
  } finally {
    await h.close();
  }
});

it("isolates runtime failures, allows recovery from degradation and leaves other Sources operational", async () => {
  const f = fixture();
  const h = f.makeHub();
  try {
    await h.ready();
    const alpha = f.hosts.get("alpha")!;
    const beta = f.hosts.get("beta")!;
    alpha.reportHealth("degraded");
    expect((await h.inject("/api/health")).json().sources[0].state).toBe(
      "degraded",
    );
    alpha.reportHealth("healthy");
    expect((await h.inject("/api/health")).json().sources[0].state).toBe(
      "healthy",
    );
    alpha.reportHealth("failed");
    alpha.reportHealth("healthy");
    expect(
      (await h.inject("/api/health"))
        .json()
        .sources.map((s: { state: string }) => s.state),
    ).toEqual(["failed", "healthy"]);
    await expect(alpha.submit(event())).rejects.toMatchObject({
      code: "source_unavailable",
    });
    expect((await beta.submit(event())).status).toBe("unroutable");
    expect(f.calls.filter((x) => x === "start:alpha")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

it("aborts and attempts every stop once even when one fails", async () => {
  const f = fixture({ failStop: "alpha" });
  const h = f.makeHub();
  await h.ready();
  await h.close();
  await h.close();
  expect(f.calls).toEqual([
    "start:alpha",
    "start:beta",
    "abort:alpha",
    "abort:beta",
    "stop:alpha",
    "stop:beta",
  ]);
  await expect(f.hosts.get("beta")!.submit(event())).rejects.toMatchObject({
    code: "source_unavailable",
  });
});

it("bounds shutdown when a stop hook never resolves", async () => {
  const f = fixture({ hangStop: "alpha" });
  const h = f.makeHub();
  await h.ready();
  await h.close();
  expect(f.calls).toContain("stop:beta");
  expect(h.getSourceHealth()[0]).toMatchObject({
    state: "stopped",
    stopFailure: "stop_timeout",
  });
}, 4000);

it.each(["ready", "failure", "cancel"] as const)(
  "uses the CLI loader and launcher IPC path (%s)",
  async (mode) => {
    const failStart = mode === "failure";
    const dir = temporaryDir();
    const trace = join(dir, "trace.txt");
    const settings = config(["alpha"]);
    settings.sources!.alpha.config = {
      trace,
      failStart,
      hangStart: mode === "cancel",
    };
    settings.plugins = {
      hub: [
        {
          id: "fixture-source",
          kind: "source",
          module: resolve("tests/fixtures/active-source.mjs"),
        },
      ],
    };
    writeFileSync(
      join(dir, "taskcircuit.config.json"),
      JSON.stringify(settings),
    );
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    if (!address || typeof address === "string")
      throw new Error("test port unavailable");
    await new Promise<void>((done) => socket.close(() => done()));
    const child = fork(resolve("dist/cli.js"), ["hub"], {
      cwd: dir,
      env: {
        ...process.env,
        TASKCIRCUIT_HOME: join(dir, "state"),
        TASKCIRCUIT_PORT: String(address.port),
      },
      execArgv: [],
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    let ready = false;
    child.on("message", (message) => {
      const type = (message as { type?: string }).type;
      if (type === "ready") ready = true;
      if (type === "ready" || type === "fixture-starting")
        child.send({ type: "shutdown" });
    });
    const guard = setTimeout(() => child.kill(), 4000);
    try {
      const [code] = await exited;
      expect(ready).toBe(mode === "ready");
      expect(code).toBe(failStart ? 1 : 0);
      expect(readFileSync(trace, "utf8")).toBe("start\nabort\nstop\n");
      expect(stderr).not.toContain("private startup detail");
      if (failStart) expect(stderr).toContain("source_start_failed");
    } finally {
      clearTimeout(guard);
    }
  },
  6000,
);
