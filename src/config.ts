import { readFileSync } from "node:fs";
export interface AgentProfile {
  adapter: "mock";
  model?: string;
  reasoning?: string;
  config?: Record<string, unknown>;
}
export interface Route {
  id: string;
  event: { source: string; type: string };
  agent: string;
  title: string;
}
export interface Config {
  agents: Record<string, AgentProfile>;
  routes: Route[];
}
export const defaultConfig: Config = {
  agents: { "demo-agent": { adapter: "mock" } },
  routes: [
    {
      id: "demo-color",
      event: { source: "local", type: "demo.color" },
      agent: "demo-agent",
      title: "颜色试跑",
    },
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
  for (const [name, agent] of Object.entries(config.agents))
    if (!name || !agent || agent.adapter !== "mock")
      throw new Error(`Agent 配置无效: ${name}`);
  const ids = new Set<string>();
  const matches = new Set<string>();
  for (const route of config.routes) {
    if (
      !route ||
      typeof route.id !== "string" ||
      !route.id ||
      typeof route.title !== "string" ||
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
