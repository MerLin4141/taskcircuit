import { readFileSync } from "node:fs";
import { validPolicy } from "./scheduling.js";
import { isAbsolute } from "node:path";
export const defaultConfig = {
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
                strategy: "fixed",
                initialDelaySeconds: 2,
                maxDelaySeconds: 2,
            },
        })),
        ...["codex", "claude"].map((adapter) => ({
            id: `${adapter}-later`,
            event: { source: "local", type: `demo.${adapter}.later` },
            agent: `${adapter}-demo`,
            title: "Later 试跑",
            instruction: `第一次请返回 later，afterSeconds 必须为 2，message 为稍后继续。恢复后返回 complete，message 必须精确为「TaskCircuit ${adapter === "codex" ? "Codex" : "Claude"} Later 试跑通过」，不含界定符和标点。`,
        })),
        ...["mock", "codex", "claude"].map((adapter) => ({
            id: `demo-${adapter}`,
            event: { source: "local", type: `demo.${adapter}.color` },
            agent: `${adapter}-demo`,
            title: "颜色试跑",
            instruction: "第一次请提问：请选择一个颜色，选项为蓝色和绿色。回答为蓝色时，完成结果的 message 必须精确等于「你选了蓝色，TaskCircuit 试跑通过」；回答为绿色时，message 必须精确等于「你选了绿色，TaskCircuit 试跑通过」。方括号是界定符，不是结果的一部分，结果末尾不加标点。",
        })),
    ],
};
export function loadConfig(path) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("配置必须是对象");
    const config = value;
    if (!config.agents ||
        typeof config.agents !== "object" ||
        Array.isArray(config.agents) ||
        !Array.isArray(config.routes))
        throw new Error("配置缺少 agents 或 routes");
    for (const [name, agent] of Object.entries(config.agents)) {
        if (!name ||
            !agent ||
            !["mock", "codex", "claude"].includes(agent.adapter) ||
            (agent.isolation !== undefined && agent.isolation !== "trusted-local") ||
            (agent.workspaceRoot !== undefined &&
                (typeof agent.workspaceRoot !== "string" ||
                    !isAbsolute(agent.workspaceRoot))))
            throw new Error(`Agent 配置无效或隔离模式尚不支持: ${name}`);
        agent.isolation ??= "trusted-local";
    }
    const ids = new Set();
    const matches = new Set();
    for (const route of config.routes) {
        if (!route ||
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
            !config.agents[route.agent])
            throw new Error("路由配置无效");
        const match = JSON.stringify([route.event.source, route.event.type]);
        if (ids.has(route.id) || matches.has(match))
            throw new Error("路由 ID 或事件匹配重复");
        ids.add(route.id);
        matches.add(match);
    }
    if (config.channels !== undefined &&
        (!config.channels ||
            typeof config.channels !== "object" ||
            Array.isArray(config.channels) ||
            Object.entries(config.channels).some(([id, c]) => !id || !c || c.type !== "local-console")))
        throw new Error("通知通道配置无效");
    for (const route of config.routes)
        if (route.notify?.some((id) => !(config.channels ?? { local: { type: "local-console" } })[id]))
            throw new Error("通知通道不存在");
    if (config.schedules !== undefined) {
        if (!Array.isArray(config.schedules))
            throw new Error("计划配置无效");
        const scheduleIds = new Set();
        for (const schedule of config.schedules) {
            if (!schedule ||
                typeof schedule.id !== "string" ||
                !schedule.id ||
                scheduleIds.has(schedule.id) ||
                typeof schedule.cron !== "string" ||
                !schedule.event ||
                typeof schedule.event.source !== "string" ||
                typeof schedule.event.type !== "string" ||
                !config.routes.some((r) => r.event.source === schedule.event.source &&
                    r.event.type === schedule.event.type))
                throw new Error("计划配置无效");
            scheduleIds.add(schedule.id);
        }
    }
    return config;
}
