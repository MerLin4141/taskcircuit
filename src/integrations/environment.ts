import type { Config } from "../config.js";

const runtimeNames = new Set([
  "TASKCIRCUIT_HOME",
  "TASKCIRCUIT_CONFIG",
  "TASKCIRCUIT_CONFIG_DEFAULT",
  "TASKCIRCUIT_PORT",
  "TASKCIRCUIT_SCHEDULER_INTERVAL_MS",
  "TASKCIRCUIT_WORKSPACE_ROOT",
]);

export function isIntegrationSecretEnv(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^TASKCIRCUIT_[A-Z0-9_]+$/.test(name) &&
    name.trim() === name &&
    !runtimeNames.has(name)
  );
}

export function resolveIntegrationSecret(name: unknown): string {
  if (!isIntegrationSecretEnv(name))
    throw new Error("integration_secret_reference_invalid");
  const value = process.env[name];
  if (!value || !value.trim())
    throw new Error("integration_secret_unavailable");
  return value;
}

export function workerEnvironment(
  config: Config,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const references = new Set(
    [
      ...Object.values(config.sources ?? {}).map(
        (source) => source.config?.secretEnv,
      ),
      ...Object.values(config.channels ?? {}).flatMap(({ config }) => [
        config?.webhookUrlEnv,
        config?.signingSecretEnv,
      ]),
    ]
      .filter(isIntegrationSecretEnv)
      .map((name) => name.toUpperCase()),
  );
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !references.has(name.toUpperCase())),
  );
}

export function removeWorkerSecrets(config: Config): void {
  const safe = workerEnvironment(config, process.env);
  for (const name of Object.keys(process.env))
    if (!Object.hasOwn(safe, name)) delete process.env[name];
}
