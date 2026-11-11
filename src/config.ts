import { validDeclaration, type PluginDeclaration } from "./plugins/loader.js";
import { readFileSync } from "node:fs";
import { validPolicy, type RetryPolicy } from "./scheduling.js";
import { isAbsolute } from "node:path";
export interface AgentProfile {
  adapter: string;
  isolation?: "trusted-local" | "sandboxed";
  workspaceRoot?: string;
  model?: string | null;
  reasoning?: string;
  config?: Record<string, unknown>;
}
export interface Route {
  id: string;
  event: { source: string; type: string };
  agent: string;
  title: string;
  instruction?: string;
  automationId?: string;
  retryPolicy?: RetryPolicy;
  notify?: string[];
  notifyOnCompleted?: boolean;
}
export interface ConfigSchedule {
  id: string;
  cron: string;
  timezone?: string;
  event: { source: string; type: string; payload?: Record<string, unknown> };
}
export interface SourceInstanceConfig {
  type: string;
  required?: boolean;
  config?: Record<string, unknown>;
}
export interface Config {
  agents: Record<string, AgentProfile>;
  routes: Route[];
  schedules?: ConfigSchedule[];
  channels?: Record<string, { type: string }>;
  sources?: Record<string, SourceInstanceConfig>;
  plugins?: { hub?: PluginDeclaration[]; worker?: PluginDeclaration[] };
  policyWorkspaces?: Record<
    string,
    { path: string; allowedRoot: string; allowedCapabilities: string[] }
  >;
}
export const defaultConfig: Config = {
  channels: { local: { type: "local-console" } },
  agents: {
    "demo-agent": { adapter: "mock", isolation: "trusted-local" },
    "mock-demo": { adapter: "mock", isolation: "trusted-local" },
    "codex-demo": { adapter: "codex", model: null, isolation: "trusted-local" },
    "claude-demo": {
      adapter: "claude",
      model: null,
      isolation: "trusted-local",
    },
  },
  routes: [
    {
      id: "demo-loop",
      event: { source: "local", type: "demo.loop" },
      agent: "mock-demo",
      title: "自主循环试跑",
    },
    {
      id: "demo-color",
      event: { source: "local", type: "demo.color" },
      agent: "demo-agent",
      title: "颜色试跑",
    },
    ...["later", "retry", "retry.exhaust", "cron", "lease"].map((kind) => ({
      id: `mock-${kind}`,
      event: { source: "local", type: `demo.${kind}` },
      agent: "mock-demo",
      title: `试跑 ${kind}`,
      retryPolicy: {
        maxAttempts: 3,
        strategy: "fixed" as const,
        initialDelaySeconds: 2,
        maxDelaySeconds: 2,
      },
    })),
    ...(["codex", "claude"] as const).map((adapter) => ({
      id: `${adapter}-later`,
      event: { source: "local", type: `demo.${adapter}.later` },
      agent: `${adapter}-demo`,
      title: "Later 试跑",
      instruction: `第一次请返回 later，afterSeconds 必须为 2，message 为稍后继续。恢复后返回 complete，message 必须精确为「TaskCircuit ${adapter === "codex" ? "Codex" : "Claude"} Later 试跑通过」，不含界定符和标点。`,
    })),
    ...(["mock", "codex", "claude"] as const).map((adapter) => ({
      id: `demo-${adapter}`,
      event: { source: "local", type: `demo.${adapter}.color` },
      agent: `${adapter}-demo`,
      title: "颜色试跑",
      instruction:
        "第一次请提问：请选择一个颜色，选项为蓝色和绿色。回答为蓝色时，完成结果的 message 必须精确等于「你选了蓝色，TaskCircuit 试跑通过」；回答为绿色时，message 必须精确等于「你选了绿色，TaskCircuit 试跑通过」。方括号是界定符，不是结果的一部分，结果末尾不加标点。",
    })),
  ],
};
const sourceId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateSources(config: Config): void {
  const sources = config.sources;
  if (
    sources !== undefined &&
    (!record(sources) ||
      Object.entries(sources).some(
        ([id, entry]) =>
          !sourceId(id) ||
          ["local", "local-cli"].includes(id) ||
          !record(entry) ||
          Object.keys(entry).some(
            (key) => !["type", "required", "config"].includes(key),
          ) ||
          !sourceId(entry.type) ||
          (entry.required !== undefined &&
            typeof entry.required !== "boolean") ||
          (entry.config !== undefined && !record(entry.config)),
      ))
  )
    throw new Error("source_config_invalid");

  for (const route of config.routes) {
    const local = route.event.source === "local";
    if (!local && !Object.hasOwn(sources ?? {}, route.event.source))
      throw new Error("source_route_instance_unknown");
    if (
      route.automationId !== undefined &&
      (local || !sourceId(route.automationId))
    )
      throw new Error("source_route_automation_invalid");
  }

  if (config.schedules?.some((schedule) => schedule.event.source !== "local"))
    throw new Error("source_schedule_not_local");
}

export function loadConfig(path: string): Config {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("配置必须是对象");
  const config = value as Config;
  if (
    !config.agents ||
    typeof config.agents !== "object" ||
    Array.isArray(config.agents) ||
    !Array.isArray(config.routes)
  )
    throw new Error("配置缺少 agents 或 routes");
  if (config.plugins !== undefined) {
    if (
      !config.plugins ||
      typeof config.plugins !== "object" ||
      Array.isArray(config.plugins) ||
      Object.keys(config.plugins).some((k) => k !== "hub" && k !== "worker")
    )
      throw new Error("plugin_config_invalid: 插件配置无效");
    for (const processKind of ["hub", "worker"] as const) {
      const entries = config.plugins[processKind];
      if (
        entries !== undefined &&
        (!Array.isArray(entries) ||
          entries.some((entry) => !validDeclaration(entry, processKind)))
      )
        throw new Error("plugin_config_invalid: 插件配置无效");
    }
  }
  const agentIds = new Set([
    "mock",
    "codex",
    "claude",
    ...(config.plugins?.worker ?? []).map((p) => p.id),
  ]);
  const channelIds = new Set([
    "local-console",
    ...(config.plugins?.hub ?? [])
      .filter((p) => p.kind === "channel")
      .map((p) => p.id),
  ]);
  for (const [name, agent] of Object.entries(config.agents)) {
    if (
      !name ||
      !agent ||
      !agentIds.has(agent.adapter) ||
      (agent.isolation !== undefined && agent.isolation !== "trusted-local") ||
      (agent.workspaceRoot !== undefined &&
        (typeof agent.workspaceRoot !== "string" ||
          !isAbsolute(agent.workspaceRoot)))
    )
      throw new Error(`Agent 配置无效或隔离模式尚不支持: ${name}`);
    agent.isolation ??= "trusted-local";
  }
  const ids = new Set<string>();
  const matches = new Set<string>();
  for (const route of config.routes) {
    if (
      !route ||
      typeof route.id !== "string" ||
      !route.id ||
      typeof route.title !== "string" ||
      (route.retryPolicy !== undefined && !validPolicy(route.retryPolicy)) ||
      (route.notify !== undefined &&
        (!Array.isArray(route.notify) ||
          !route.notify.every((x) => typeof x === "string" && !!x))) ||
      (route.notifyOnCompleted !== undefined &&
        typeof route.notifyOnCompleted !== "boolean") ||
      (route.instruction !== undefined &&
        typeof route.instruction !== "string") ||
      !route.event ||
      typeof route.event.source !== "string" ||
      typeof route.event.type !== "string" ||
      !config.agents[route.agent]
    )
      throw new Error("路由配置无效");
    const match = JSON.stringify([route.event.source, route.event.type]);
    if (ids.has(route.id) || matches.has(match))
      throw new Error("路由 ID 或事件匹配重复");
    ids.add(route.id);
    matches.add(match);
  }
  if (
    config.channels !== undefined &&
    (!config.channels ||
      typeof config.channels !== "object" ||
      Array.isArray(config.channels) ||
      Object.entries(config.channels).some(
        ([id, c]) => !id || !c || !channelIds.has(c.type),
      ))
  )
    throw new Error("通知通道配置无效");
  for (const route of config.routes)
    if (
      route.notify?.some(
        (id) => !(config.channels ?? { local: { type: "local-console" } })[id],
      )
    )
      throw new Error("通知通道不存在");
  if (config.schedules !== undefined) {
    if (!Array.isArray(config.schedules)) throw new Error("计划配置无效");
    const scheduleIds = new Set<string>();
    for (const schedule of config.schedules) {
      if (
        !schedule ||
        typeof schedule.id !== "string" ||
        !schedule.id ||
        scheduleIds.has(schedule.id) ||
        typeof schedule.cron !== "string" ||
        !schedule.event ||
        typeof schedule.event.source !== "string" ||
        typeof schedule.event.type !== "string" ||
        !config.routes.some(
          (r) =>
            r.event.source === schedule.event.source &&
            r.event.type === schedule.event.type,
        )
      )
        throw new Error("计划配置无效");
      scheduleIds.add(schedule.id);
    }
  }
  validateSources(config);
  return config;
}
