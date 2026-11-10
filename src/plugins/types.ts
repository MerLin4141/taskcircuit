import type { NotificationChannel } from "../notifications.js";
import type { EventEnvelope, TrustedSource } from "../event-core.js";
import type { AgentAdapter, AgentExecutionInput } from "../adapter.js";

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
  ingest(input: unknown): {
    sourceContext: TrustedSource;
    envelope: EventEnvelope;
  };
}
export interface AgentPlugin extends PluginBase, AgentAdapter {
  readonly manifest: PluginManifest & { kind: "agent" };
  prepareWorkingDirectory?(path: string): void;
  prepareInput?(input: AgentExecutionInput): AgentExecutionInput;
}
export interface ChannelPlugin extends PluginBase {
  readonly manifest: PluginManifest & { kind: "channel" };
  createChannel(config: { id: string }): NotificationChannel;
}
export type Plugin = SourcePlugin | AgentPlugin | ChannelPlugin;
