import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { Config } from "./config.js";
import { SetupError } from "./config-path.js";
import { isIntegrationSecretEnv } from "./integrations/environment.js";
import { githubPlugin } from "./plugins/builtin/github.js";
import { webhookPlugin } from "./plugins/builtin/webhook.js";
import { createFeishuPlugin } from "./plugins/builtin/feishu.js";

type Status = "PASS" | "WARN" | "FAIL";
type Check = {
  status: Status;
  id?: string;
  implementation?: string;
  message?: string;
  references?: { name: string; state: "SET" | "MISSING" }[];
};
const sourcePlugins = new Map([
  ["github", githubPlugin],
  ["webhook", webhookPlugin],
]);

function checkReferences(
  values: unknown[],
  failure: Status,
): Pick<Check, "status" | "references" | "message"> {
  const references: NonNullable<Check["references"]> = [];
  const invalid = values.some((value) => !isIntegrationSecretEnv(value));
  for (const value of values) {
    if (!isIntegrationSecretEnv(value)) continue;
    references.push({
      name: value,
      state: process.env[value]?.trim() ? "SET" : "MISSING",
    });
  }
  const missing = references
    .filter((entry) => entry.state === "MISSING")
    .map((entry) => entry.name);
  return invalid
    ? {
        status: failure,
        references,
        message: "请配置有效的 TASKCIRCUIT_ 环境变量引用。",
      }
    : missing.length
      ? {
          status: failure,
          references,
          message: "请在 Hub 的环境中设置 " + missing.join(", ") + "。",
        }
      : { status: "PASS", references };
}

export function inspectIntegrations(
  config: Config,
  managementPort: number,
  inspectSettings: boolean,
) {
  const sources: Check[] = Object.entries(config.sources ?? {}).map(
    ([id, entry]) => {
      const info = { id, implementation: entry.type };
      const plugin = sourcePlugins.get(entry.type);
      if (!plugin) {
        const declared = config.plugins?.hub?.some(
          (p) => p.kind === "source" && p.id === entry.type,
        );
        return declared
          ? {
              ...info,
              status: "WARN",
              message: "已声明外部插件。启动时检查 API 和加载状态。",
            }
          : {
              ...info,
              status: "FAIL",
              message: "请注册 Source 实现或检查 sources 中的 type。",
            };
      }
      const failure = entry.required === false ? "WARN" : "FAIL";
      const settings = entry.config ?? {};
      const check = checkReferences([settings.secretEnv], failure);
      if (inspectSettings && check.status === "PASS") {
        try {
          const instance = plugin.createSource(settings, {
            async submit() {
              throw new Error("preflight");
            },
            reportHealth() {},
          });
          void instance.stop?.();
        } catch {
          return {
            ...info,
            ...check,
            status: failure,
            message: "请检查 Source 实例设置及数字 ID 白名单。",
          };
        }
      }
      return { ...info, ...check };
    },
  );
  const channels: Check[] = Object.entries(
    config.channels ?? { local: { type: "local-console" } },
  ).map(([id, entry]) => {
    const info = { id, implementation: entry.type };
    if (entry.type === "local-console") return { ...info, status: "PASS" };
    if (entry.type !== "feishu-channel")
      return {
        ...info,
        status: "WARN",
        message: "已声明外部插件。启动时检查 API 和加载状态。",
      };
    const settings = entry.config ?? {};
    const check = checkReferences(
      [settings.webhookUrlEnv, settings.signingSecretEnv],
      "FAIL",
    );
    if (inspectSettings && check.status === "PASS") {
      try {
        createFeishuPlugin().createChannel(
          { id, config: settings },
          {
            signal: new AbortController().signal,
            reportHealth() {},
          },
        );
      } catch {
        return {
          ...info,
          ...check,
          status: "FAIL",
          message:
            "请检查飞书 HTTPS v2 webhook 地址和 timeoutMs（1000–10000）。",
        };
      }
    }
    return { ...info, ...check };
  });
  const needsIngress = Object.values(config.sources ?? {}).some((entry) =>
    sourcePlugins.has(entry.type),
  );
  const port = config.integrationIngress?.port;
  const ingress: Check & { port?: number; host?: string } =
    port === managementPort && needsIngress
      ? {
          status: "FAIL",
          port,
          message: "integrationIngress.port 必须与 TASKCIRCUIT_PORT 不同。",
        }
      : port !== undefined
        ? {
            status: "PASS",
            port,
            host: "127.0.0.1",
            message: "回环地址 127.0.0.1:" + port,
          }
        : needsIngress
          ? {
              status: "FAIL",
              message: "HTTP Source 需要 integrationIngress.port。",
            }
          : { status: "PASS", message: "无需集成监听端口。" };
  return { sources, channels, ingress };
}

export function validateStartupIntegrations(
  config: Config,
  port: number,
): void {
  const { sources, channels, ingress } = inspectIntegrations(
    config,
    port,
    false,
  );
  const failed = [...sources, ...channels].find(
    (entry) => entry.status === "FAIL",
  );
  if (failed) {
    const code = failed.references?.some((entry) => entry.state === "MISSING")
      ? "required_environment_missing"
      : "integration_config_invalid";
    throw new SetupError(
      code,
      failed.implementation + " 实例 " + failed.id + "：" + failed.message,
    );
  }
  if (ingress.status === "FAIL")
    throw new SetupError("integration_port_invalid", ingress.message ?? "");
}

export function inspectWorkspaces(config: Config): Check[] {
  return Object.entries(config.policyWorkspaces ?? {}).map(([id, ws]) => {
    try {
      if (!isAbsolute(ws.path) || !isAbsolute(ws.allowedRoot))
        throw new Error();
      const path = realpathSync(ws.path),
        root = realpathSync(ws.allowedRoot);
      const rel = relative(root, path);
      if (
        rel === ".." ||
        rel.startsWith(".." + sep) ||
        isAbsolute(rel) ||
        !statSync(path).isDirectory() ||
        !statSync(root).isDirectory()
      )
        throw new Error();
      accessSync(
        path,
        constants.R_OK |
          (ws.allowedCapabilities.includes("write_files") ? constants.W_OK : 0),
      );
      return { id, status: "PASS" };
    } catch {
      return {
        id,
        status: "FAIL",
        message:
          "请检查工作目录和 allowedRoot，确认目录存在、在允许范围内且当前用户可访问。",
      };
    }
  });
}
