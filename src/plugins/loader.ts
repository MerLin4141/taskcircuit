import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { supportsPluginApi, type PluginRegistry } from "./registry.js";
import { PluginApiVersionError } from "./errors.js";
import { ACTIVE_SOURCE_API_VERSION } from "./types.js";
import type { Plugin, PluginKind } from "./types.js";

export interface PluginDeclaration {
  id: string;
  kind: PluginKind;
  module: string;
}
export type PluginProcess = "hub" | "worker";
export class PluginLoadError extends Error {
  constructor(
    public readonly code: "plugin_load_failed" | "plugin_config_invalid",
    processKind: PluginProcess,
    id: string,
  ) {
    super(`${code}: ${processKind} plugin ${id}`);
    this.name = "PluginLoadError";
  }
}
export function validDeclaration(
  decl: unknown,
  processKind: PluginProcess,
): decl is PluginDeclaration {
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) return false;
  const d = decl as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(d.id) &&
    typeof d.module === "string" &&
    !!d.module.trim() &&
    (processKind === "worker"
      ? d.kind === "agent"
      : d.kind === "source" || d.kind === "channel")
  );
}
function modulePath(
  specifier: string,
  configPath: string,
  processKind: PluginProcess,
  id: string,
): string {
  if (specifier !== specifier.trim() || /[\x00-\x1f\x7f]/.test(specifier))
    throw new PluginLoadError("plugin_config_invalid", processKind, id);
  if (
    specifier.startsWith("//") ||
    specifier.startsWith("\\\\") ||
    builtinModules.includes(specifier)
  )
    throw new PluginLoadError("plugin_config_invalid", processKind, id);
  if (isAbsolute(specifier)) return specifier;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier))
    throw new PluginLoadError("plugin_config_invalid", processKind, id);
  if (/^\.{1,2}[\\/]/.test(specifier))
    return resolve(dirname(configPath), specifier);
  if (
    !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i.test(specifier) ||
    specifier === "." ||
    specifier === ".."
  )
    throw new PluginLoadError("plugin_config_invalid", processKind, id);
  try {
    // Resolve with Node's ESM import conditions from the trusted config directory.
    const url = execFileSync(
      process.execPath,
      [
        "--experimental-import-meta-resolve",
        "--input-type=module",
        "-e",
        "import {pathToFileURL} from 'node:url';process.stdout.write(import.meta.resolve(process.argv[1],pathToFileURL(process.argv[2]).href))",
        specifier,
        resolve(configPath),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096 },
    );
    const file = fileURLToPath(url);
    if (!isAbsolute(file)) throw new Error("not a local module");
    return file;
  } catch {
    throw new PluginLoadError("plugin_load_failed", processKind, id);
  }
}
export async function loadTrustedPlugins(
  registry: PluginRegistry,
  configPath: string,
  declarations: readonly PluginDeclaration[],
  processKind: PluginProcess,
): Promise<void> {
  for (const declaration of declarations) {
    if (!validDeclaration(declaration, processKind))
      throw new PluginLoadError(
        "plugin_config_invalid",
        processKind,
        "<invalid>",
      );
  }
  for (const { id, kind, module: specifier } of declarations) {
    const file = modulePath(specifier, resolve(configPath), processKind, id);
    let plugin: Plugin;
    try {
      const imported: unknown = await import(pathToFileURL(file).href);
      const factory = (imported as { default?: unknown }).default;
      if (typeof factory !== "function") throw new Error();
      const value: unknown = factory();
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      const manifest = (
        value as {
          manifest?: { id?: unknown; kind?: unknown; apiVersion?: unknown };
        }
      ).manifest;
      if (!manifest || manifest.id !== id || manifest.kind !== kind)
        throw new Error();
      if (!supportsPluginApi(kind, manifest.apiVersion))
        throw new PluginApiVersionError(id, kind);
      const method =
        kind === "agent"
          ? "execute"
          : kind === "source"
            ? manifest.apiVersion === ACTIVE_SOURCE_API_VERSION
              ? "createSource"
              : "ingest"
            : "createChannel";
      if (typeof (value as Record<string, unknown>)[method] !== "function")
        throw new Error();
      plugin = value as Plugin;
    } catch (error) {
      if (error instanceof PluginApiVersionError) throw error;
      throw new PluginLoadError("plugin_load_failed", processKind, id);
    }
    registry.register(plugin);
  }
}
