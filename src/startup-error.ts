import { SetupError } from "./config-path.js";
import {
  PluginNotFoundError,
  PluginRegistrationError,
} from "./plugins/errors.js";
import { PluginLoadError } from "./plugins/loader.js";

export const startupHints = {
  config_argument_invalid: "请检查 --config 参数。",
  config_not_found: "请检查固定的配置文件路径。",
  config_invalid: "配置无效。请运行 taskcircuit doctor --config 检查。",
  required_environment_missing:
    "Hub 缺少集成环境变量。请检查计划任务用户的启动环境，并运行 doctor。",
  integration_config_invalid:
    "集成配置无效。请运行 doctor 检查 Source、Channel 和环境引用。",
  integration_port_invalid: "请检查集成端口配置，确保与管理端口不同。",
  integration_listen_failed:
    "集成端口无法监听。请检查端口占用和 integrationIngress.port。",
  management_port_occupied: "管理端口已被占用。请检查 TASKCIRCUIT_PORT。",
  plugin_api_incompatible: "插件 API 版本不兼容。请检查所配置的插件版本。",
  plugin_not_found: "找不到所配置的插件。请检查实现 ID 和插件声明。",
  plugin_load_failed: "插件加载失败。请检查配置文件旁的模块路径和插件声明。",
  plugin_config_invalid: "插件声明无效。请检查插件 ID、种类和模块路径。",
  source_start_failed: "Source 启动失败。请运行 doctor 检查来源设置。",
} as const;

type StartupCode = keyof typeof startupHints;
export function startupCode(error: unknown): StartupCode | undefined {
  const code =
    error instanceof SetupError ||
    error instanceof PluginRegistrationError ||
    error instanceof PluginNotFoundError ||
    error instanceof PluginLoadError
      ? error.code
      : error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? "management_port_occupied"
        : error instanceof Error &&
            error.message.startsWith("source_start_failed:")
          ? "source_start_failed"
          : error instanceof Error && error.message.startsWith("feishu_")
            ? "integration_config_invalid"
            : error instanceof Error
              ? error.message
              : undefined;
  return typeof code === "string" && Object.hasOwn(startupHints, code)
    ? (code as StartupCode)
    : undefined;
}

export function startupHint(code: unknown): string | undefined {
  return typeof code === "string" && Object.hasOwn(startupHints, code)
    ? startupHints[code as StartupCode]
    : undefined;
}
