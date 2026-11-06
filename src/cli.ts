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
    const hub = createHub(join(home, "taskcircuit.db"), config);
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
  if (command === "status") {
    print(await api("/api/work-items"));
    return;
  }
  console.log(
    "用法: taskcircuit hub | worker [--once] | emit <事件类型> | work <工作ID> | answer <问题ID> <回答> | status",
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "运行失败");
  process.exitCode = 1;
});
