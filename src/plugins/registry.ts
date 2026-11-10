import {
  PluginApiVersionError,
  PluginNotFoundError,
  PluginRegistrationError,
} from "./errors.js";
import {
  PLUGIN_API_VERSION,
  type AgentPlugin,
  type ChannelPlugin,
  type Plugin,
  type PluginKind,
  type SourcePlugin,
} from "./types.js";

export class PluginRegistry {
  private readonly sources = new Map<string, SourcePlugin>();
  private readonly agents = new Map<string, AgentPlugin>();
  private readonly channels = new Map<string, ChannelPlugin>();

  // Only trusted composition code supplies constructed plugins; event data is never a registry input.
  register(plugin: Plugin): void {
    const manifest: unknown =
      plugin && typeof plugin === "object" ? plugin.manifest : null;
    const fields =
      manifest && typeof manifest === "object"
        ? (manifest as Record<string, unknown>)
        : {};
    const id = typeof fields.id === "string" ? fields.id : "<invalid>";
    const kind = typeof fields.kind === "string" ? fields.kind : "<invalid>";
    if (
      !id.trim() ||
      !["source", "agent", "channel"].includes(kind) ||
      typeof fields.id !== "string" ||
      typeof fields.version !== "string" ||
      !fields.version.trim() ||
      typeof fields.apiVersion !== "number" ||
      !Number.isInteger(fields.apiVersion)
    ) {
      throw new PluginRegistrationError(
        "plugin_manifest_invalid",
        id,
        kind,
        "invalid manifest",
      );
    }
    if (fields.apiVersion !== PLUGIN_API_VERSION)
      throw new PluginApiVersionError(id, kind);
    const map = this.map(kind as PluginKind);
    if (map.has(id))
      throw new PluginRegistrationError(
        "plugin_duplicate",
        id,
        kind,
        "duplicate registration",
      );
    switch (plugin.manifest.kind) {
      case "source":
        this.sources.set(id, plugin as SourcePlugin);
        break;
      case "agent":
        this.agents.set(id, plugin as AgentPlugin);
        break;
      case "channel":
        this.channels.set(id, plugin as ChannelPlugin);
        break;
    }
  }
  private map(kind: PluginKind): Map<string, Plugin> {
    switch (kind) {
      case "source":
        return this.sources;
      case "agent":
        return this.agents;
      case "channel":
        return this.channels;
    }
  }
  private get<T extends Plugin>(
    map: Map<string, T>,
    kind: PluginKind,
    id: string,
  ): T {
    const found = map.get(id);
    if (!found) throw new PluginNotFoundError(id, kind);
    return found;
  }
  private list<T extends Plugin>(map: Map<string, T>): T[] {
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, plugin]) => plugin);
  }
  getSource(id: string): SourcePlugin {
    return this.get(this.sources, "source", id);
  }
  getAgent(id: string): AgentPlugin {
    return this.get(this.agents, "agent", id);
  }
  getChannel(id: string): ChannelPlugin {
    return this.get(this.channels, "channel", id);
  }
  hasSource(id: string): boolean {
    return this.sources.has(id);
  }
  hasAgent(id: string): boolean {
    return this.agents.has(id);
  }
  hasChannel(id: string): boolean {
    return this.channels.has(id);
  }
  listSources(): SourcePlugin[] {
    return this.list(this.sources);
  }
  listAgents(): AgentPlugin[] {
    return this.list(this.agents);
  }
  listChannels(): ChannelPlugin[] {
    return this.list(this.channels);
  }
}
