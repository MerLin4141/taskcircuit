#!/usr/bin/env node
import { createHub } from "./hub.js";
import { defaultConfig, loadConfig } from "./config.js";
import { workOnce } from "./worker.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { task, runContained } from "./platform/windows/task.js";
import { readRuntimeStatus, stopRuntime, waitStopped, portOccupied, } from "./platform/windows/runtime.js";
import { resolveCli, detectCli } from "./agents/capability.js";
import { ProcessRunner } from "./agents/process.js";
import { formatWorkItemList, formatWorkItem, formatInbox, formatRuntimeStatus, formatDoctor, } from "./cli-format.js";
const args = process.argv.slice(2);
const command = args.shift();
const jsonMode = (command === "runtime"
    ? args[0] === "status"
    : ["status", "work", "inbox", "doctor"].includes(command ?? "")) &&
    args.includes("--json");
if (jsonMode)
    args.splice(args.indexOf("--json"), 1);
const port = Number(process.env.TASKCIRCUIT_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("端口不正确");
const base = `http://127.0.0.1:${port}`;
async function api(path, method = "GET", data) {
    const response = await fetch(new URL(path, base), {
        method,
        headers: { "content-type": "application/json" },
        body: data === undefined ? undefined : JSON.stringify(data),
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`${response.status}: ${text}`);
    return text ? JSON.parse(text) : null;
}
const print = (value) => console.log(JSON.stringify(value, null, 2));
async function main() {
    if (command === "hub") {
        const home = process.env.TASKCIRCUIT_HOME ?? join(homedir(), ".taskcircuit");
        mkdirSync(join(home, "logs"), { recursive: true });
        const configPath = join(process.cwd(), "taskcircuit.config.json");
        const config = existsSync(configPath)
            ? loadConfig(configPath)
            : defaultConfig;
        const interval = Number(process.env.TASKCIRCUIT_SCHEDULER_INTERVAL_MS ?? 1000);
        if (!Number.isInteger(interval) || interval < 10)
            throw new Error("调度间隔不正确");
        const hub = createHub(join(home, "taskcircuit.db"), config, undefined, interval);
        await hub.listen({ port, host: "127.0.0.1" });
        let closing = false;
        const close = async () => {
            if (closing)
                return;
            closing = true;
            await hub.close();
            if (process.connected)
                process.disconnect();
        };
        process.on("message", (message) => {
            if (message &&
                typeof message === "object" &&
                message.type === "shutdown")
                void close();
        });
        process.on("SIGINT", () => {
            void close();
        });
        process.on("SIGTERM", () => {
            void close();
        });
        if (process.connected)
            process.send?.({ type: "ready" });
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            component: "hub",
            message: "Hub 已启动",
            workItemId: null,
            executionId: null,
            workerId: null,
        }));
        return;
    }
    if (command === "worker") {
        const workerId = `worker-${randomUUID()}`;
        let stopping = false;
        const shutdown = new AbortController();
        const stop = () => {
            stopping = true;
            shutdown.abort();
        };
        process.on("message", (message) => {
            if (message &&
                typeof message === "object" &&
                message.type === "shutdown")
                stop();
        });
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        if (args.includes("--once")) {
            await workOnce(base, workerId, undefined, shutdown.signal);
            return;
        }
        const presence = async (status) => {
            try {
                await api(`/api/workers/${encodeURIComponent(workerId)}/heartbeat`, "POST", { status });
            }
            catch { }
        };
        await presence("online");
        const timer = setInterval(() => {
            void presence("online");
        }, 10000);
        timer.unref();
        if (process.connected)
            process.send?.({ type: "ready" });
        try {
            while (!stopping) {
                try {
                    if (!(await workOnce(base, workerId, undefined, shutdown.signal)) &&
                        !stopping)
                        await new Promise((r) => setTimeout(r, 1000));
                }
                catch (e) {
                    console.error(JSON.stringify({
                        timestamp: new Date().toISOString(),
                        level: "error",
                        component: "worker",
                        message: e instanceof Error ? e.message : "执行失败",
                        workItemId: null,
                        executionId: null,
                        workerId,
                    }));
                    if (!stopping)
                        await new Promise((r) => setTimeout(r, 1000));
                }
            }
        }
        finally {
            clearInterval(timer);
            await presence("stopped");
            if (process.connected)
                process.disconnect();
        }
        return;
    }
    if (command === "--version" || command === "-V") {
        const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
        console.log(pkg.version);
        return;
    }
    if (command === "runtime") {
        const home = process.env.TASKCIRCUIT_HOME ?? join(homedir(), ".taskcircuit");
        const action = args[0];
        if (action === "--help" || action === "-h") {
            console.log("用法: taskcircuit runtime install | start | stop | restart | status | uninstall");
            return;
        }
        const waitStartupTask = async () => {
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                const info = await task("inspect", home);
                if (!info.installed || info.state !== "Running")
                    return;
                await new Promise((r) => setTimeout(r, 250));
            }
            throw new Error("Windows Startup Task 停止超时");
        };
        const checkPort = async () => {
            if (await portOccupied(port)) {
                let isTaskCircuit = false;
                try {
                    const response = await fetch(new URL("/api/health", base), {
                        signal: AbortSignal.timeout(1500),
                    });
                    if (response.ok) {
                        const health = (await response.json());
                        isTaskCircuit = health.service === "taskcircuit";
                    }
                }
                catch { }
                throw new Error(isTaskCircuit
                    ? `端口 ${port} 已有 TaskCircuit Hub，请先停止它`
                    : `端口 ${port} 被其他程序占用`);
            }
        };
        if (action === "run") {
            process.exitCode = await runContained(home);
            return;
        }
        if (action === "install") {
            print(await task("install", home));
            return;
        }
        if (action === "status") {
            const startup = await task("inspect", home);
            const state = await readRuntimeStatus(home);
            let health = null;
            let workers = [];
            try {
                health = await api("/api/health");
                workers = await api("/api/workers");
            }
            catch { }
            const result = {
                windowsStartupTask: startup,
                runtime: state,
                hub: health,
                workers,
                home,
            };
            if (jsonMode)
                print(result);
            else
                console.log(formatRuntimeStatus(result));
            return;
        }
        if (action === "stop") {
            await stopRuntime(home);
            await waitStopped(home);
            await waitStartupTask();
            print({ stopped: true });
            return;
        }
        if (action === "uninstall") {
            const startup = await task("inspect", home);
            const state = await readRuntimeStatus(home);
            if (startup.state === "Running" && state.runtime !== "running")
                throw new Error("无法确认正在运行的任务身份，请先检查 Windows Startup Task");
            if (state.runtime === "running") {
                await stopRuntime(home);
                await waitStopped(home);
                await waitStartupTask();
            }
            await task("uninstall", home);
            try {
                unlinkSync(join(home, "runtime", "runtime.json"));
            }
            catch { }
            print({ uninstalled: true, dataPreserved: true });
            return;
        }
        if (action === "restart") {
            const state = await readRuntimeStatus(home);
            if (state.runtime === "running") {
                await stopRuntime(home);
                await waitStopped(home);
                await waitStartupTask();
            }
            await checkPort();
            print(await task("start", home));
            return;
        }
        if (action === "start") {
            const state = await readRuntimeStatus(home);
            if (state.runtime === "running")
                throw new Error("Runtime 已在运行");
            const startup = await task("inspect", home);
            if (!startup.installed)
                throw new Error("Windows Startup Task 尚未安装，请运行 taskcircuit runtime install");
            await checkPort();
            print(await task("start", home));
            return;
        }
        throw new Error("用法: taskcircuit runtime install/start/stop/restart/status/uninstall/run");
    }
    if (command === "doctor") {
        const home = process.env.TASKCIRCUIT_HOME ?? join(homedir(), ".taskcircuit");
        const report = {
            node: { status: "PASS", version: process.version },
            home: { status: existsSync(home) ? "PASS" : "WARN", path: home },
            sqlite: { status: "WARN", message: "Not checked" },
            codex: { status: "WARN" },
            claude: { status: "WARN" },
        };
        try {
            await import("node:sqlite");
            report.sqlite = { status: "PASS", message: "Built-in SQLite available" };
        }
        catch {
            report.sqlite = {
                status: "FAIL",
                message: "Built-in SQLite unavailable",
            };
        }
        try {
            report.hub = { status: "PASS", detail: await api("/api/health") };
            const entries = (await api("/api/workers"));
            report.workers = {
                status: entries.some((x) => x.state === "online") ? "PASS" : "WARN",
                detail: entries,
            };
        }
        catch {
            report.hub = { status: "WARN", message: "Hub unavailable" };
            report.workers = { status: "WARN", message: "Worker status unavailable" };
        }
        if (process.platform === "win32") {
            try {
                const info = await task("inspect", home);
                report.windowsStartupTask = {
                    status: info.installed ? "PASS" : "WARN",
                    detail: info,
                };
            }
            catch {
                report.windowsStartupTask = {
                    status: "WARN",
                    message: "无法检查 Windows Startup Task",
                };
            }
        }
        for (const kind of ["codex", "claude"]) {
            try {
                resolveCli(kind);
                const supported = await detectCli(kind, new ProcessRunner(), process.cwd());
                report[kind] = {
                    status: supported ? "PASS" : "WARN",
                    message: supported
                        ? "CLI detected; authentication not verified"
                        : "CLI detected but required options were not confirmed",
                };
            }
            catch {
                report[kind] = { status: "WARN", message: "CLI unavailable" };
            }
        }
        if (jsonMode)
            print(report);
        else
            console.log(formatDoctor(report));
        if (Object.values(report).some((v) => v.status === "FAIL"))
            process.exitCode = 1;
        return;
    }
    if (command === "emit" && args[0]) {
        print(await api("/api/events", "POST", {
            source: "local",
            type: args[0],
            payload: {},
        }));
        return;
    }
    if (command === "work" && args[0]) {
        const detail = (await api(`/api/work-items/${encodeURIComponent(args[0])}`));
        if (detail.agentSession?.externalSessionId)
            detail.agentSession.externalSessionId = "present";
        if (jsonMode)
            print(detail);
        else
            console.log(formatWorkItem(detail));
        return;
    }
    if (command === "answer" && args.length >= 2) {
        print(await api(`/api/interactions/${encodeURIComponent(args[0])}/answer`, "POST", { answer: args[1] }));
        return;
    }
    if (command === "schedule") {
        const action = args.shift();
        if (action === "--help" || action === "-h") {
            console.log("用法: taskcircuit schedule list | add --event 类型 (--cron 表达式 [--timezone 时区] | --at 时间) | pause ID | resume ID | cancel ID");
            return;
        }
        if (action === "list") {
            print(await api("/api/schedules"));
            return;
        }
        if (action === "add") {
            const options = {};
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
            print(await api("/api/schedules", "POST", options.cron
                ? {
                    kind: "cron",
                    expression: options.cron,
                    timezone: options.timezone ?? "UTC",
                    event,
                }
                : { kind: "once", runAt: options.at, event }));
            return;
        }
        const id = args[0];
        if (!id)
            throw new Error("请指定计划 ID");
        if (action === "cancel") {
            print(await api(`/api/schedules/${encodeURIComponent(id)}`, "DELETE"));
            return;
        }
        if (action === "pause" || action === "resume") {
            print(await api(`/api/schedules/${encodeURIComponent(id)}/${action}`, "POST", {}));
            return;
        }
        throw new Error("计划命令不正确");
    }
    if (command === "inbox") {
        const entries = await api("/api/inbox");
        if (jsonMode)
            print(entries);
        else
            console.log(formatInbox(entries));
        return;
    }
    if (command === "watch") {
        const after = args.indexOf("--after");
        const cursor = after >= 0 ? args[after + 1] : "0";
        if (!cursor || !/^\d+$/.test(cursor))
            throw new Error("游标不正确");
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        try {
            const response = await fetch(new URL(`/api/stream?after=${cursor}`, base), { signal: controller.signal });
            if (!response.ok)
                throw new Error(`连接变化流失败: ${response.status} ${await response.text()}`);
            if (!response.body)
                throw new Error("变化流不可用");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let end;
                while ((end = buffer.indexOf("\n\n")) >= 0) {
                    const frame = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const id = frame.match(/^id: (.+)$/m)?.[1];
                    const event = frame.match(/^event: (.+)$/m)?.[1];
                    const data = frame.match(/^data: (.+)$/m)?.[1];
                    if (event === "resync") {
                        console.error("变化流游标已过期，请刷新状态后重新连接");
                        return;
                    }
                    if (event === "change" && id && data) {
                        const change = JSON.parse(data);
                        console.log(`[${id}] ${change.type}${change.payload?.status ? " → " + change.payload.status : ""}`);
                    }
                }
            }
        }
        catch (error) {
            if (!controller.signal.aborted)
                throw error;
        }
        finally {
            process.off("SIGINT", stop);
        }
        return;
    }
    if (command === "status") {
        const items = await api("/api/work-items");
        if (jsonMode)
            print(items);
        else
            console.log(formatWorkItemList(items));
        return;
    }
    console.log("用法: taskcircuit hub | worker [--once] | emit <事件类型> | work <工作ID> | answer <问题ID> <回答> | status | inbox | watch [--after 序号] | doctor | runtime | schedule list/add/pause/resume/cancel");
}
main().catch((e) => {
    console.error(e instanceof Error ? e.message : "运行失败");
    process.exitCode = 1;
});
