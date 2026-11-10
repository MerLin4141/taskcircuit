// Guards kind isolation, deterministic registration, and fail-fast manifest validation.
import { describe, expect, it } from "vitest";
import { PluginRegistry } from "../src/plugins/registry.js";
import {
  PLUGIN_API_VERSION,
  type Plugin,
  type PluginKind,
} from "../src/plugins/types.js";
import {
  PluginApiVersionError,
  PluginNotFoundError,
  PluginRegistrationError,
} from "../src/plugins/errors.js";

const plugin = <K extends PluginKind>(kind: K, id: string) => ({
  manifest: { id, kind, apiVersion: PLUGIN_API_VERSION, version: "1.0.0" },
});

describe("plugin registry foundation", () => {
  it("registers and finds all three kinds", () => {
    const r = new PluginRegistry();
    const source = plugin("source", "in");
    const agent = plugin("agent", "run");
    const channel = plugin("channel", "out");
    r.register(source);
    r.register(agent);
    r.register(channel);
    expect(r.getSource("in")).toBe(source);
    expect(r.getAgent("run")).toBe(agent);
    expect(r.getChannel("out")).toBe(channel);
    expect(r.hasSource("in")).toBe(true);
    expect(r.hasAgent("run")).toBe(true);
    expect(r.hasChannel("out")).toBe(true);
  });
  it.each(["source", "agent", "channel"] as const)(
    "reports missing %s without confusing kinds",
    (kind) => {
      const r = new PluginRegistry();
      const get = {
        source: () => r.getSource("missing"),
        agent: () => r.getAgent("missing"),
        channel: () => r.getChannel("missing"),
      }[kind];
      expect(get).toThrow(PluginNotFoundError);
      try {
        get();
      } catch (error) {
        expect(error).toMatchObject({
          code: "plugin_not_found",
          kind,
          pluginId: "missing",
        });
      }
    },
  );
  it("rejects duplicates and retains the first plugin", () => {
    const r = new PluginRegistry();
    const first = plugin("agent", "codex");
    r.register(first);
    expect(() => r.register(plugin("agent", "codex"))).toThrow(
      PluginRegistrationError,
    );
    try {
      r.register(plugin("agent", "codex"));
    } catch (error) {
      expect(error).toMatchObject({
        code: "plugin_duplicate",
        kind: "agent",
        pluginId: "codex",
      });
    }
    expect(r.getAgent("codex")).toBe(first);
  });
  it("allows identical identifiers in independent kind namespaces", () => {
    const r = new PluginRegistry();
    r.register(plugin("agent", "local"));
    r.register(plugin("source", "local"));
    r.register(plugin("channel", "local"));
    expect(r.listAgents()).toHaveLength(1);
    expect(r.listSources()).toHaveLength(1);
    expect(r.listChannels()).toHaveLength(1);
  });
  it.each([0, 2])(
    "rejects incompatible API version %i during registration",
    (version) => {
      const r = new PluginRegistry();
      const invalid = {
        manifest: { ...plugin("agent", "wrong").manifest, apiVersion: version },
      };
      expect(() => r.register(invalid)).toThrow(PluginApiVersionError);
      try {
        r.register(invalid);
      } catch (error) {
        expect(error).toMatchObject({
          code: "plugin_api_incompatible",
          kind: "agent",
          pluginId: "wrong",
        });
      }
      expect(r.hasAgent("wrong")).toBe(false);
    },
  );
  it.each([
    { id: "", kind: "agent", apiVersion: 1, version: "1" },
    { id: "  ", kind: "agent", apiVersion: 1, version: "1" },
    { id: "x", kind: "unknown", apiVersion: 1, version: "1" },
    { id: "x", kind: "agent", apiVersion: 1, version: "" },
    { id: "x", kind: "agent", apiVersion: 1, version: "  " },
    { id: "x", kind: "agent", apiVersion: "1", version: "1" },
  ])("rejects invalid manifest %#", (manifest) => {
    const r = new PluginRegistry();
    try {
      r.register({ manifest } as unknown as Plugin);
      expect.fail("invalid manifest accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "plugin_manifest_invalid" });
    }
    expect(r.listAgents()).toHaveLength(0);
  });
  it("returns deterministic ID order independently of registration order", () => {
    const r = new PluginRegistry();
    for (const id of ["z", "a", "m"]) {
      r.register(plugin("source", id));
      r.register(plugin("agent", id));
      r.register(plugin("channel", id));
    }
    for (const list of [r.listSources(), r.listAgents(), r.listChannels()])
      expect(list.map((p) => p.manifest.id)).toEqual(["a", "m", "z"]);
    r.listAgents().pop();
    expect(r.listAgents()).toHaveLength(3);
  });
  it("keeps separate registries isolated and permits process-specific kinds", () => {
    const hub = new PluginRegistry();
    const worker = new PluginRegistry();
    hub.register(plugin("source", "local"));
    hub.register(plugin("channel", "console"));
    worker.register(plugin("agent", "mock"));
    expect(hub.hasAgent("mock")).toBe(false);
    expect(worker.hasSource("local")).toBe(false);
    expect(worker.listChannels()).toEqual([]);
    expect(hub.listAgents()).toEqual([]);
  });
  it("does not register event-shaped data or expose an automatic loader", () => {
    const r = new PluginRegistry();
    const eventPayload = {
      plugin: "agent:evil",
      module: "C:/untrusted/evil.js",
      apiVersion: 2,
    };
    expect(() => r.register(eventPayload as unknown as Plugin)).toThrow(
      PluginRegistrationError,
    );
    expect(r.hasAgent("evil")).toBe(false);
    expect(Object.keys(r)).not.toContain("loader");
  });
  it("registers a minimal trusted test builtin through the ordinary path", () => {
    const registerTestBuiltin = (registry: PluginRegistry) =>
      registry.register(plugin("source", "test-builtin"));
    const registry = new PluginRegistry();
    registerTestBuiltin(registry);
    expect(registry.getSource("test-builtin").manifest.apiVersion).toBe(1);
    expect(() => registerTestBuiltin(registry)).toThrow(
      PluginRegistrationError,
    );
  });
});
