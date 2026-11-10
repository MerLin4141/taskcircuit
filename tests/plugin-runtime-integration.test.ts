// Guards startup ordering and normal execution/delivery for trusted external plugin fixtures.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "./fixtures/g2-hub.js";
import { loadConfig } from "../src/config.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { loadTrustedPlugins } from "../src/plugins/loader.js";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = () => {
  const d = mkdtempSync(join(tmpdir(), "tc-plugin-e2e-"));
  dirs.push(d);
  return d;
};
const child = (dir: string, command: string, port: number) =>
  new Promise<{ code: number | null; stderr: string }>(
    (resolveResult, reject) => {
      const p = spawn(
        process.execPath,
        [resolve("dist/cli.js"), command, "--once"],
        {
          cwd: dir,
          env: {
            ...process.env,
            TASKCIRCUIT_HOME: join(dir, "state"),
            TASKCIRCUIT_PORT: String(port),
            TASKCIRCUIT_WORKSPACE_ROOT: join(dir, "workspaces"),
          },
          windowsHide: true,
        },
      );
      let stderr = "";
      p.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      p.on("error", reject);
      p.on("exit", (code) => resolveResult({ code, stderr }));
    },
  );
const write = (dir: string, name: string, text: string) =>
  writeFileSync(join(dir, name), text);
const baseConfig = (
  plugins: unknown,
  adapter = "external-agent",
  channel = "local-console",
) => ({
  agents: { ext: { adapter, isolation: "trusted-local" } },
  routes: [
    {
      id: "r",
      event: { source: "local", type: "sample.task" },
      agent: "ext",
      title: "sample",
      notifyOnCompleted: true,
    },
  ],
  channels: { alerts: { type: channel } },
  plugins,
});

describe("external plugin runtime", () => {
  it("loads an Agent at Worker startup and commits its result through the real Hub", async () => {
    const d = setup();
    write(
      d,
      "agent.mjs",
      `import {existsSync} from 'node:fs'; export default () => ({manifest:{id:'external-agent',kind:'agent',apiVersion:1,version:'1'},async execute(input,signal){ if(!signal || input.externalSessionId!==null || !existsSync(input.workingDirectory)) throw Error('input'); return {type:'completed',sessionId:'fixture-session',output:'fixture-done'} }})`,
    );
    const raw = baseConfig({
      worker: [{ id: "external-agent", kind: "agent", module: "./agent.mjs" }],
    });
    const configPath = join(d, "taskcircuit.config.json");
    writeFileSync(configPath, JSON.stringify(raw));
    const h = createHub(":memory:", loadConfig(configPath), undefined, 0, {
      dispatcherPollMs: 0,
      channels: {},
    });
    try {
      const base = await h.listen({ host: "127.0.0.1", port: 0 });
      const port = Number(new URL(base).port);
      const created = (
        await h.inject({
          method: "POST",
          url: "/api/events",
          payload: {
            source: "local",
            type: "sample.task",
            payload: { module: "./evil.mjs" },
          },
        })
      ).json();
      const result = await child(d, "worker", port);
      expect(result.code, result.stderr).toBe(0);
      const state = (
        await h.inject(`/api/work-items/${created.workItem.id}`)
      ).json();
      expect(state.workItem.status).toBe("completed");
      expect(state.agentSession.externalSessionId).toBe("fixture-session");
    } finally {
      await h.close();
    }
  });
  it("loads Channel and Source modules into Hub registry and delivers through normal dispatcher", async () => {
    const d = setup();
    write(
      d,
      "channel.mjs",
      `export default () => ({manifest:{id:'external-channel',kind:'channel',apiVersion:1,version:'1'},events:[],createChannel({id}){return {id,deliver:async input=>{this.events.push(input);return {ok:this.events.length>1}}}}})`,
    );
    write(
      d,
      "source.mjs",
      `export default () => ({manifest:{id:'external-source',kind:'source',apiVersion:1,version:'1'},ingest(input){return {sourceContext:{sourceInstance:'fixture',trustContext:'external_untrusted'},envelope:input}}})`,
    );
    const entries = [
      { id: "external-channel", kind: "channel", module: "./channel.mjs" },
      { id: "external-source", kind: "source", module: "./source.mjs" },
    ];
    const configPath = join(d, "taskcircuit.config.json");
    writeFileSync(
      configPath,
      JSON.stringify(baseConfig({ hub: entries }, "mock", "external-channel")),
    );
    const config = loadConfig(configPath),
      registry = createHubPluginRegistry();
    await loadTrustedPlugins(registry, configPath, config.plugins!.hub!, "hub");
    expect(registry.hasSource("external-source")).toBe(true);
    let now = Date.parse("2026-01-01T00:00:00Z");
    const h = createHub(
      ":memory:",
      config,
      () => now,
      0,
      { dispatcherPollMs: 0 },
      { registry, sourceId: "local" },
    );
    try {
      const item = (
        await h.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "sample.task", payload: {} },
        })
      ).json();
      const c = (
        await h.inject({
          method: "POST",
          url: "/api/executions/claim",
          payload: { workerId: "w" },
        })
      ).json();
      expect(
        (
          await h.inject({
            method: "POST",
            url: `/api/executions/${c.execution.id}/result`,
            payload: {
              workerId: "w",
              leaseToken: c.leaseToken,
              result: {
                type: "completed",
                sessionId: "fixture",
                output: "done",
              },
            },
          })
        ).statusCode,
      ).toBe(200);
      await h.dispatchNotifications();
      expect(
        (await h.inject("/api/notifications")).json()[0].deliveries[0],
      ).toMatchObject({ status: "queued", attempt: 1 });
      now += 5000;
      await h.dispatchNotifications();
      const note = (await h.inject("/api/notifications")).json()[0];
      expect(note.deliveries[0]).toMatchObject({
        channelId: "alerts",
        status: "sent",
      });
      expect(
        (registry.getChannel("external-channel") as any).events,
      ).toHaveLength(2);
      expect(item.workItem.id).toBeTruthy();
    } finally {
      await h.close();
    }
    const sourceHub = createHub(
      ":memory:",
      config,
      undefined,
      0,
      { dispatcherPollMs: 0 },
      { registry, sourceId: "external-source" },
    );
    try {
      const event = await sourceHub.inject({
        method: "POST",
        url: "/api/events/v2",
        payload: {
          sourceEventId: "source-1",
          type: "unknown.fixture",
          payload: { message: "hello" },
        },
      });
      expect(event.statusCode).toBe(200);
      const details = (
        await sourceHub.inject(`/api/events/v2/${event.json().eventId}`)
      ).json();
      expect(details.event).toMatchObject({
        sourceInstance: "fixture",
        trustContext: "external_untrusted",
      });
    } finally {
      await sourceHub.close();
    }
  });
  it("rejects a broken Worker plugin before announcing presence or claiming", async () => {
    const d = setup();
    const raw = baseConfig({
      worker: [
        { id: "external-agent", kind: "agent", module: "./missing.mjs" },
      ],
    });
    write(d, "taskcircuit.config.json", JSON.stringify(raw));
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("port");
      const result = await child(d, "worker", address.port);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("plugin_load_failed");
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("rejects a broken Hub plugin before reaching ready state", async () => {
    const d = setup();
    const raw = baseConfig(
      { hub: [{ id: "broken", kind: "source", module: "./missing.mjs" }] },
      "mock",
    );
    write(d, "taskcircuit.config.json", JSON.stringify(raw));
    const result = await child(d, "hub", 4318);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("plugin_load_failed");
  });
});
