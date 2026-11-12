import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { defaultConfig, loadConfig } from "./config.js";

export class SetupError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function takeConfigFlag(args: string[]): string | undefined {
  if (args.some((arg) => arg.startsWith("--config=")))
    throw new SetupError(
      "config_argument_invalid",
      "请使用 --config <配置文件路径>。",
    );
  const first = args.indexOf("--config");
  if (first === -1) return undefined;
  const value = args[first + 1];
  if (
    first !== args.lastIndexOf("--config") ||
    !value?.trim() ||
    value.startsWith("--")
  )
    throw new SetupError(
      "config_argument_invalid",
      "请使用一次 --config <配置文件路径>。",
    );
  args.splice(first, 2);
  return value;
}

export function resolveConfigPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | null {
  const selected = explicit ?? env.TASKCIRCUIT_CONFIG;
  if (selected === undefined && env.TASKCIRCUIT_CONFIG_DEFAULT === "1")
    return null;
  const path = resolve(cwd, selected ?? "taskcircuit.config.json");
  if (selected === undefined && !existsSync(path)) return null;
  try {
    if (selected?.trim() === "" || !statSync(path).isFile()) throw new Error();
    return realpathSync(path);
  } catch {
    throw new SetupError(
      "config_not_found",
      "找不到可读取的配置文件 " +
        path +
        "。请检查 --config 或 TASKCIRCUIT_CONFIG。",
    );
  }
}

export function readSelectedConfig(path: string | null) {
  if (path === null) return defaultConfig;
  try {
    return loadConfig(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    let hint = "请检查 agents、routes、sources、channels 和 plugins。";
    let code = "config_invalid";
    if (error instanceof SyntaxError)
      hint = "JSON 格式错误，请检查引号、逗号和括号。";
    else if (message === "integration_ingress_config_invalid") {
      code = "integration_port_invalid";
      hint = "请检查 integrationIngress.port（1–65535）和 maxConcurrent。";
    } else if (message === "source_route_instance_unknown")
      hint = "请将 routes 的 Source 实例注册到 sources。";
    else if (message.includes("通知通道"))
      hint = "请检查 channels 的类型和 routes 的通知通道 ID。";
    else if (message.includes("Agent") || message.includes("路由"))
      hint = "请检查 Agent 类型和 routes 引用的 Agent 配置名。";
    throw new SetupError(code, path + " 的配置无效。" + hint);
  }
}
