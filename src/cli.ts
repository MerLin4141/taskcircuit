#!/usr/bin/env node
import { createHub } from "./hub.js";
import { defaultConfig, loadConfig } from "./config.js";
import { workOnce } from "./worker.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
const args = process.argv.slice(2);
const command = args.shift();
const base = "http://127.0.0.1:4317";
async function api(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<unknown> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function main(): Promise<void> {
  if (command === "hub") {
    const home =
      process.env.TASKCIRCUIT_HOME ?? join(homedir(), ".taskcircuit");
    mkdirSync(join(home, "logs"), { recursive: true });
    const configPath = join(process.cwd(), "taskcircuit.config.json");
    const config = existsSync(configPath)
      ? loadConfig(configPath)
      : defaultConfig;
    const interval = Number(
      process.env.TASKCIRCUIT_SCHEDULER_INTERVAL_MS ?? 1000,
    );
    if (!Number.isInteger(interval) || interval < 10)
      throw new Error("调度间隔不正确");
    const hub = createHub(
      join(home, "taskcircuit.db"),
      config,
      undefined,
      interval,
    );
    await hub.listen({ port: 4317, host: "127.0.0.1" });
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "info",
        component: "hub",
        message: "Hub 已启动",
        workItemId: null,
        executionId: null,
        workerId: null,
      }),
    );
    return;
  }
  if (command === "worker") {
    const workerId = `worker-${randomUUID()}`;
    if (args.includes("--once")) {
      await workOnce(base, workerId);
      return;
    }
    for (;;) {
      try {
        if (!(await workOnce(base, workerId)))
          await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            component: "worker",
            message: e instanceof Error ? e.message : "执行失败",
            workItemId: null,
            executionId: null,
            workerId,
          }),
        );
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  if (command === "emit" && args[0]) {
    print(
      await api("/api/events", "POST", {
        source: "local",
        type: args[0],
        payload: {},
      }),
    );
    return;
  }
  if (command === "work" && args[0]) {
    const detail = (await api(
      `/api/work-items/${encodeURIComponent(args[0])}`,
    )) as { agentSession?: { externalSessionId?: string } };
    if (detail.agentSession?.externalSessionId)
      detail.agentSession.externalSessionId = "present";
    print(detail);
    return;
  }
  if (command === "answer" && args.length >= 2) {
    print(
      await api(
        `/api/interactions/${encodeURIComponent(args[0])}/answer`,
        "POST",
        { answer: args[1] },
      ),
    );
    return;
  }
  if (command === "schedule") {
    const action = args.shift();
    if (action === "list") {
      print(await api("/api/schedules"));
      return;
    }
    if (action === "add") {
      const options: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 2) {
        if (!args[i]?.startsWith("--") || !args[i + 1])
          throw new Error("计划参数不正确");
        options[args[i].slice(2)] = args[i + 1];
      }
      const event = {
        source: options.source ?? "local",
        type: options.event,
        payload: {},
      };
      if (!event.type || !!options.cron === !!options.at)
        throw new Error("请指定 --event 和 --cron 或 --at");
      print(
        await api(
          "/api/schedules",
          "POST",
          options.cron
            ? {
                kind: "cron",
                expression: options.cron,
                timezone: options.timezone ?? "UTC",
                event,
              }
            : { kind: "once", runAt: options.at, event },
        ),
      );
      return;
    }
    const id = args[0];
    if (!id) throw new Error("请指定计划 ID");
    if (action === "cancel") {
      print(await api(`/api/schedules/${encodeURIComponent(id)}`, "DELETE"));
      return;
    }
    if (action === "pause" || action === "resume") {
      print(
        await api(
          `/api/schedules/${encodeURIComponent(id)}/${action}`,
          "POST",
          {},
        ),
      );
      return;
    }
    throw new Error("计划命令不正确");
  }
  if (command === "status") {
    print(await api("/api/work-items"));
    return;
  }
  console.log(
    "用法: taskcircuit hub | worker [--once] | emit <事件类型> | work <工作ID> | answer <问题ID> <回答> | status | schedule list/add/pause/resume/cancel",
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "运行失败");
  process.exitCode = 1;
});
