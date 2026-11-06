import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
export interface AgentProfile {
  adapter: "mock" | "codex" | "claude";
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
}
export interface Config {
  agents: Record<string, AgentProfile>;
  routes: Route[];
}
export const defaultConfig: Config = {
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
      id: "demo-color",
      event: { source: "local", type: "demo.color" },
      agent: "demo-agent",
      title: "颜色试跑",
    },
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
  for (const [name, agent] of Object.entries(config.agents)) {
    if (
      !name ||
      !agent ||
      !["mock", "codex", "claude"].includes(agent.adapter) ||
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
  return config;
}
