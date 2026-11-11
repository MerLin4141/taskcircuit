// Guards trusted config anchoring, fail-fast manifest checks and process-scoped local plugin loading.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadTrustedPlugins } from "../src/plugins/loader.js";
import { createWorkerPluginRegistry } from "../src/plugins/builtin/agents.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { loadConfig } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "tc-plugin-test-"));
  dirs.push(dir);
  return dir;
};
const moduleText = (id: string, kind = "agent", api = 1) =>
  `export default () => ({manifest:{id:${JSON.stringify(id)},kind:${JSON.stringify(kind)},apiVersion:${api},version:"1"}, ${kind === "agent" ? "execute:async()=>({type:'completed',sessionId:'fixture',output:'ok'})" : kind === "channel" ? "createChannel:({id})=>({id,deliver:async()=>({ok:true})})" : "ingest:x=>x"}})`;
const declaration = (
  id: string,
  kind: "agent" | "source" | "channel",
  module: string,
) => ({ id, kind, module });

describe("trusted local plugin loader", () => {
  it("resolves relative paths from config directory and loads independent instances", async () => {
    const dir = setup();
    const config = join(dir, "taskcircuit.config.json");
    writeFileSync(join(dir, "agent.mjs"), moduleText("sample"));
    const a = createWorkerPluginRegistry(),
      b = createWorkerPluginRegistry();
    await loadTrustedPlugins(
      a,
      config,
      [declaration("sample", "agent", "./agent.mjs")],
      "worker",
    );
    await loadTrustedPlugins(
      b,
      config,
      [declaration("sample", "agent", "./agent.mjs")],
      "worker",
    );
    expect(a.getAgent("sample")).not.toBe(b.getAgent("sample"));
    expect(resolve(process.cwd())).not.toBe(dir);
  });
  it("supports absolute files and installed packages relative to config", async () => {
    const dir = setup();
    const config = join(dir, "taskcircuit.config.json");
    const abs = join(dir, "abs.mjs");
    writeFileSync(abs, moduleText("abs"));
    const pkg = join(dir, "node_modules", "example-agent");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "example-agent",
        type: "module",
        exports: { import: "./index.mjs" },
      }),
    );
    writeFileSync(join(pkg, "index.mjs"), moduleText("pkg"));
    const r = createWorkerPluginRegistry();
    await loadTrustedPlugins(
      r,
      config,
      [
        declaration("abs", "agent", abs),
        declaration("pkg", "agent", "example-agent"),
      ],
      "worker",
    );
    expect(r.hasAgent("abs")).toBe(true);
    expect(r.hasAgent("pkg")).toBe(true);
  });
  it.each([
    "https://example.com/a.js",
    "file:///C:/a.js",
    "data:text/javascript,x",
    "node:fs",
    "fs",
    "//server/share/plugin.mjs",
    "git://host/a",
  ])("rejects URL or builtin specifier %s", async (spec) => {
    const dir = setup();
    await expect(
      loadTrustedPlugins(
        createWorkerPluginRegistry(),
        join(dir, "taskcircuit.config.json"),
        [declaration("a", "agent", spec)],
        "worker",
      ),
    ).rejects.toMatchObject({ code: "plugin_config_invalid" });
  });
  it.each([
    "wrong-id",
    "wrong-kind",
    "wrong-api",
    "duplicate",
    "bad-export",
    "missing",
    "throwing",
  ])("rejects %s before registration", async (scenario) => {
    const dir = setup();
    const file = join(dir, "p.mjs");
    let id = "sample",
      kind: "agent" | "source" = "agent",
      text = moduleText(id);
    if (scenario === "wrong-id") text = moduleText("other");
    if (scenario === "wrong-kind") text = moduleText("sample", "source");
    if (scenario === "wrong-api") text = moduleText("sample", "agent", 2);
    if (scenario === "duplicate") {
      id = "mock";
      text = moduleText("mock");
    }
    if (scenario === "bad-export") text = "export default {}";
    if (scenario === "throwing")
      text = "export default () => { throw Error('private detail') }";
    if (scenario !== "missing") writeFileSync(file, text);
    const r = createWorkerPluginRegistry();
    await expect(
      loadTrustedPlugins(
        r,
        join(dir, "taskcircuit.config.json"),
        [declaration(id, kind, "./p.mjs")],
        "worker",
      ),
    ).rejects.toThrow();
    expect(r.hasAgent("sample")).toBe(false);
  });
  it.each([1, 2, 3])(
    "enforces exact Channel API version %i",
    async (version) => {
      const dir = setup();
      writeFileSync(
        join(dir, "channel.mjs"),
        moduleText("fixture", "channel", version),
      );
      const registry = createHubPluginRegistry();
      const loading = loadTrustedPlugins(
        registry,
        join(dir, "taskcircuit.config.json"),
        [declaration("fixture", "channel", "./channel.mjs")],
        "hub",
      );
      if (version === 3) {
        await expect(loading).rejects.toMatchObject({
          code: "plugin_api_incompatible",
        });
        expect(registry.hasChannel("fixture")).toBe(false);
      } else {
        await loading;
        expect(registry.getChannel("fixture").manifest.apiVersion).toBe(
          version,
        );
      }
    },
  );
  it("rejects process-kind mismatch before importing module", async () => {
    const dir = setup(),
      file = join(dir, "agent.mjs");
    writeFileSync(file, moduleText("agent"));
    await expect(
      loadTrustedPlugins(
        createHubPluginRegistry(),
        join(dir, "taskcircuit.config.json"),
        [declaration("agent", "agent", "./agent.mjs")],
        "hub",
      ),
    ).rejects.toMatchObject({ code: "plugin_config_invalid" });
  });
  it("accepts only declared agent and channel IDs in trusted configuration", () => {
    const dir = setup(),
      p = join(dir, "taskcircuit.config.json");
    const config = {
      agents: { custom: { adapter: "x" } },
      routes: [],
      channels: { alerts: { type: "y" } },
      plugins: {
        worker: [declaration("x", "agent", "./a.mjs")],
        hub: [declaration("y", "channel", "./c.mjs")],
      },
    };
    writeFileSync(p, JSON.stringify(config));
    expect(loadConfig(p).agents.custom.adapter).toBe("x");
    config.agents.custom.adapter = "unknown";
    writeFileSync(p, JSON.stringify(config));
    expect(() => loadConfig(p)).toThrow();
  });
});
