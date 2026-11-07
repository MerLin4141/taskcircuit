import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { task } from "../dist/platform/windows/task.js";
import {
  readRuntimeStatus,
  stopRuntime,
  waitStopped,
} from "../dist/platform/windows/runtime.js";
if (process.platform !== "win32") throw new Error("Windows required");
const root = mkdtempSync(join(tmpdir(), "taskcircuit win e2e "));
const home = join(root, "state"),
  workspace = join(root, "workspace");
mkdirSync(home);
const name = `TaskCircuit-Test-${randomUUID()}`;
const base = "http://127.0.0.1:4317";
let installed = false;
let watch;
const runProcess = promisify(execFile);
const ps = join(
  process.env.SystemRoot,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const treeScript = `$all=Get-CimInstance Win32_Process; $front=@([int]$env:TC_TEST_WORKER); $found=@(); for($i=0;$i -lt 8 -and $front.Count -gt 0;$i++){ $next=@($all | Where-Object { $front -contains [int]$_.ParentProcessId }); $found+= $next; $front=@($next | ForEach-Object { [int]$_.ProcessId }) }; ConvertTo-Json -InputObject @($found | Where-Object { $_.Name -match '^(codex|claude)(\.exe)?$' } | Select-Object ProcessId,Name) -Compress`;
async function agentDescendants(workerPid) {
  const { stdout } = await runProcess(
    ps,
    ["-NoProfile", "-NonInteractive", "-Command", treeScript],
    {
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, TC_TEST_WORKER: String(workerPid) },
    },
  );
  return JSON.parse(stdout.trim() || "[]");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, data) {
  const res = await fetch(
    base + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}
async function waitFor(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(250);
  }
  throw new Error(`timeout: ${label}`);
}
async function start() {
  await waitFor(
    async () => {
      const info = await task("inspect", home, name);
      return info.state !== "Running";
    },
    "task ready",
    30000,
  );
  await task("start", home, name);
  return await waitFor(
    async () => {
      const s = await readRuntimeStatus(home);
      if (
        s.runtime !== "running" ||
        s.hub !== "running" ||
        s.worker !== "running"
      )
        return null;
      const health = await api("/api/health");
      const workers = await api("/api/workers");
      return health.ok && workers.some((w) => w.state === "online") ? s : null;
    },
    "runtime startup",
    45000,
  );
}
async function runColor(type) {
  const created = await api("/api/events", {
    source: "local",
    type,
    payload: {},
  });
  const id = created.workItem.id;
  const agentKind =
    type === "demo.codex.color"
      ? "codex"
      : type === "demo.claude.color"
        ? "claude"
        : null;
  const observed = new Set();
  let monitoring = !!agentKind;
  const monitorAgents = async () => {
    while (monitoring) {
      const state = await readRuntimeStatus(home);
      if (state.workerPid) {
        for (const row of await agentDescendants(state.workerPid))
          if (String(row.Name).toLowerCase().startsWith(agentKind))
            observed.add(Number(row.ProcessId));
      }
      await sleep(300);
    }
  };
  const monitor = monitorAgents();
  let first;
  try {
    first = await waitFor(
      async () => {
        const d = await api(`/api/work-items/${id}`);
        if (d.workItem.status === "failed") throw Error("agent failed");
        return d.workItem.status === "waiting_input" ? d : null;
      },
      `${type} ask`,
      240000,
    );
  } finally {
    monitoring = false;
    await monitor;
  }
  if (agentKind && observed.size === 0)
    throw Error(`no ${agentKind} process observed`);
  if (agentKind)
    await waitFor(
      () => [...observed].every((pid) => !alive(pid)),
      `${agentKind} child exit`,
      10000,
    );
  const session = first.agentSession;
  const interaction = first.interactions[0];
  const inbox = await api("/api/inbox");
  if (!inbox.some((x) => x.interactionId === interaction.id))
    throw Error("missing inbox");
  await waitFor(async () => {
    const n = await api("/api/notifications");
    return n.some(
      (x) =>
        x.interactionId === interaction.id &&
        x.deliveries.some((d) => d.status === "sent"),
    );
  }, "notification sent");
  await waitFor(() => {
    try {
      return readFileSync(join(home, "logs", "runtime.log"), "utf8").includes(
        "本地通知已投递",
      );
    } catch {
      return false;
    }
  }, "notification log");
  const firstCount = observed.size;
  monitoring = !!agentKind;
  const resumeMonitor = monitorAgents();
  let done;
  try {
    await api(`/api/interactions/${interaction.id}/answer`, { answer: "蓝色" });
    done = await waitFor(
      async () => {
        const d = await api(`/api/work-items/${id}`);
        return d.workItem.status === "completed" ? d : null;
      },
      `${type} done`,
      240000,
    );
  } finally {
    monitoring = false;
    await resumeMonitor;
  }
  if (agentKind && observed.size <= firstCount)
    throw Error(`no resumed ${agentKind} process observed`);
  if (agentKind)
    await waitFor(
      () => [...observed].every((pid) => !alive(pid)),
      `${agentKind} resumed child exit`,
      10000,
    );
  if (
    done.agentSession.id !== session.id ||
    done.agentSession.externalSessionId !== session.externalSessionId ||
    done.executions[1].output !== "你选了蓝色，TaskCircuit 试跑通过"
  )
    throw Error("session mismatch");
  return { type, sessionSame: true };
}
try {
  try {
    await fetch(base + "/api/health");
    throw Error("port in use");
  } catch (e) {
    if (e.message === "port in use") throw e;
  }
  console.log("安装隔离测试任务");
  await task("install", home, name, workspace);
  installed = true;
  await task("install", home, name, workspace);
  const info = await task("inspect", home, name);
  if (
    !info.installed ||
    !info.currentUser ||
    !isAbsolute(info.execute) ||
    !info.arguments.includes(process.execPath) ||
    !info.arguments.includes("launcher.js") ||
    info.trigger !== "MSFT_TaskLogonTrigger" ||
    info.logonType !== "Interactive" ||
    info.runLevel !== "Limited"
  )
    throw Error("task definition mismatch");
  console.log("启动后台 Runtime");
  const status = await start();
  console.log(
    JSON.stringify({
      runtime: status.runtime,
      hub: status.hub,
      worker: status.worker,
      task: info.state,
    }),
  );
  const head = (await api("/api/stream/head")).sequence;
  watch = spawn(
    process.execPath,
    ["dist/cli.js", "watch", "--after", String(head)],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let streamText = "";
  watch.stdout.on("data", (chunk) => {
    streamText += String(chunk);
  });
  console.log("验证 Mock 问答、通知和 SSE");
  const mock = await runColor("demo.color");
  await waitFor(
    () => streamText.includes("interaction.opened"),
    "watch output",
    5000,
  );
  watch.kill();
  console.log(JSON.stringify({ mock, sse: true }));
  console.log("验证后台 Codex");
  console.log(JSON.stringify(await runColor("demo.codex.color")));
  console.log("验证后台 Claude");
  console.log(JSON.stringify(await runColor("demo.claude.color")));
  console.log("验证 Later 停机恢复");
  const later = (
    await api("/api/events", {
      source: "local",
      type: "demo.later",
      payload: {},
    })
  ).workItem.id;
  await waitFor(async () => {
    const d = await api(`/api/work-items/${later}`);
    return d.workItem.status === "waiting_schedule";
  }, "later");
  await stopRuntime(home);
  await waitStopped(home);
  await sleep(2500);
  await start();
  const resumed = await waitFor(async () => {
    const d = await api(`/api/work-items/${later}`);
    return d.workItem.status === "completed" ? d : null;
  }, "later resume");
  if (
    resumed.executions[0].agentSessionId !==
    resumed.executions[1].agentSessionId
  )
    throw Error("later session mismatch");
  console.log(JSON.stringify({ laterRecovery: true }));
  console.log("验证 Worker 租约恢复");
  const lease = (
    await api("/api/events", {
      source: "local",
      type: "demo.lease",
      payload: {},
    })
  ).workItem.id;
  const claimed = await waitFor(async () => {
    const d = await api(`/api/work-items/${lease}`);
    return d.executions[0].status === "running" ? d : null;
  }, "lease claim");
  const execId = claimed.executions[0].id,
    expires = Date.parse(claimed.executions[0].leaseExpiresAt);
  await stopRuntime(home);
  await waitStopped(home);
  await sleep(Math.max(0, expires - Date.now() + 500));
  await start();
  const recovered = await waitFor(
    async () => {
      const d = await api(`/api/work-items/${lease}`);
      return d.workItem.status === "completed" ? d : null;
    },
    "lease recovery",
    50000,
  );
  if (
    recovered.executions[0].id !== execId ||
    recovered.executions[0].output !== "TaskCircuit Lease 试跑通过"
  )
    throw Error("lease recovery mismatch");
  console.log(JSON.stringify({ leaseRecovery: true }));
  console.log("验证后台 Cron");
  await api("/api/schedules", {
    kind: "cron",
    expression: "* * * * *",
    timezone: "UTC",
    event: { source: "local", type: "demo.cron", payload: {} },
  });
  await waitFor(
    async () => {
      const items = await api("/api/work-items");
      return items.some(
        (x) =>
          x.workItem.title === "试跑 cron" && x.workItem.status === "completed",
      );
    },
    "cron",
    80000,
  );
  console.log(JSON.stringify({ cron: true }));
  console.log("停止后台 Runtime");
  await stopRuntime(home);
  await waitStopped(home);
  console.log(JSON.stringify({ stop: true, actualRebootTested: false }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "failed");
  process.exitCode = 1;
} finally {
  if (watch && watch.exitCode === null) watch.kill();
  let cleanupSafe = true;
  try {
    const state = await readRuntimeStatus(home);
    if (state.runtime === "running") {
      await stopRuntime(home);
      await waitStopped(home);
    }
    const info = installed ? await task("inspect", home, name) : null;
    if (info?.state === "Running")
      await waitFor(
        async () => {
          const x = await task("inspect", home, name);
          return x.state !== "Running";
        },
        "task cleanup",
        30000,
      );
  } catch (e) {
    console.error("Runtime cleanup failed", e);
    process.exitCode = 1;
    cleanupSafe = false;
  }
  if (installed && cleanupSafe) {
    try {
      await task("uninstall", home, name);
    } catch (e) {
      console.error("Task cleanup failed", e);
      process.exitCode = 1;
      cleanupSafe = false;
    }
  }
  if (cleanupSafe) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (e) {
      console.error("Temporary cleanup failed", e);
      process.exitCode = 1;
    }
  } else console.error("Retained test state for manual cleanup");
}
