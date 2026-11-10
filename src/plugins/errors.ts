import type { PluginKind } from "./types.js";

export class PluginRegistrationError extends Error {
  constructor(
    public readonly code:
      | "plugin_duplicate"
      | "plugin_manifest_invalid"
      | "plugin_api_incompatible",
    public readonly pluginId: string,
    public readonly kind: string,
    reason: string,
  ) {
    super(`Plugin ${kind}:${pluginId}: ${reason}`);
    this.name = "PluginRegistrationError";
  }
}

export class PluginApiVersionError extends PluginRegistrationError {
  constructor(id: string, kind: string) {
    super("plugin_api_incompatible", id, kind, "incompatible API version");
    this.name = "PluginApiVersionError";
  }
}

export class PluginNotFoundError extends Error {
  readonly code = "plugin_not_found";
  constructor(
    public readonly pluginId: string,
    public readonly kind: PluginKind,
  ) {
    super(`Plugin ${kind}:${pluginId}: not found`);
    this.name = "PluginNotFoundError";
  }
}
