import type { NotificationChannel } from "../notifications.js";
import type {
  EventEnvelope,
  EventResult,
  TrustedSource,
} from "../event-core.js";
import type { AgentAdapter, AgentExecutionInput } from "../adapter.js";

export const PLUGIN_API_VERSION = 1 as const;

export const ACTIVE_SOURCE_API_VERSION = 2 as const;

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

export interface SourcePluginV1 extends PluginBase {
  readonly manifest: PluginManifest & { kind: "source"; apiVersion: 1 };
  ingest(input: unknown): {
    sourceContext: TrustedSource;
    envelope: EventEnvelope;
  };
}
export type SourceSubmission = Pick<
  EventEnvelope,
  "sourceEventId" | "type" | "payload" | "correlationKey" | "occurredAt"
>;
export type SourceSubmitResult = Pick<EventResult, "status" | "eventId">;
export type SourceHealth =
  "starting" | "healthy" | "degraded" | "failed" | "stopped";

export interface SourceHost {
  submit(input: SourceSubmission): Promise<SourceSubmitResult>;
  reportHealth(state: "healthy" | "degraded" | "failed"): void;
}

export interface SourceInstance {
  start(signal: AbortSignal): Promise<void>;
  stop?(): Promise<void>;
}

export interface SourcePluginV2 extends PluginBase {
  readonly manifest: PluginManifest & { kind: "source"; apiVersion: 2 };
  createSource(
    config: Record<string, unknown>,
    host: SourceHost,
  ): SourceInstance;
}

export type SourcePlugin = SourcePluginV1 | SourcePluginV2;
export function isActiveSource(plugin: SourcePlugin): plugin is SourcePluginV2 {
  return plugin.manifest.apiVersion === ACTIVE_SOURCE_API_VERSION;
}

export interface AgentPlugin extends PluginBase, AgentAdapter {
  readonly manifest: PluginManifest & { kind: "agent"; apiVersion: 1 };
  prepareWorkingDirectory?(path: string): void;
  prepareInput?(input: AgentExecutionInput): AgentExecutionInput;
}
export interface ChannelPlugin extends PluginBase {
  readonly manifest: PluginManifest & { kind: "channel"; apiVersion: 1 };
  createChannel(config: { id: string }): NotificationChannel;
}
export type Plugin = SourcePlugin | AgentPlugin | ChannelPlugin;
