export const PLUGIN_API_VERSION = 1 as const;

export type PluginKind = "source" | "agent" | "channel";

export interface PluginManifest {
  readonly id: string;
  readonly kind: PluginKind;
  readonly apiVersion: number;
  readonly version: string;
}

export interface PluginBase {
  readonly manifest: PluginManifest;
}

export interface SourcePlugin extends PluginBase {
  readonly manifest: PluginManifest & { kind: "source" };
}
export interface AgentPlugin extends PluginBase {
  readonly manifest: PluginManifest & { kind: "agent" };
}
export interface ChannelPlugin extends PluginBase {
  readonly manifest: PluginManifest & { kind: "channel" };
}
export type Plugin = SourcePlugin | AgentPlugin | ChannelPlugin;
