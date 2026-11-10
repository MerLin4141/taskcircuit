import { TaskCircuitError } from "../../domain.js";
import type { EventEnvelope } from "../../event-core.js";
import { PluginRegistry } from "../registry.js";
import { PLUGIN_API_VERSION, type SourcePlugin } from "../types.js";

export function createHubPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  const local: SourcePlugin = {
    manifest: {
      id: "local",
      kind: "source",
      apiVersion: PLUGIN_API_VERSION,
      version: "0.2.0",
    },
    ingest(input: unknown) {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TaskCircuitError("event_invalid", "事件格式不正确", 400);
      return {
        sourceContext: {
          sourceInstance: "local-cli",
          trustContext: "trusted_local_cli",
        },
        envelope: input as EventEnvelope,
      };
    },
  };
  registry.register(local);
  return registry;
}
