import { fork, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  renameSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipePath } from "./runtime.js";
import { RuntimeLog } from "./log.js";
import { defaultConfig, loadConfig } from "../../config.js";
import { workerEnvironment } from "../../integrations/environment.js";
const home = process.env.TASKCIRCUIT_HOME;
if (!home) throw new Error("未配置 Runtime Home");
const line = await new Promise<string>((resolve) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += String(chunk);
    if (text.includes("\n")) resolve(text.trim());
  });
  process.stdin.on("end", () => resolve(text.trim()));
});
if (line !== "start") throw new Error("Job Object 启动握手失败");
const log = new RuntimeLog(home);
const runtimeId = randomUUID();
const token = randomBytes(32).toString("hex");
const dir = join(home, "runtime");
mkdirSync(dir, { recursive: true });
const metadataPath = join(dir, "runtime.json");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const cli = join(root, "dist", "cli.js");
const pipe = pipePath(home);
let hub: ChildProcess | undefined,
  worker: ChildProcess | undefined,
  stopping = false;
let shutdownPromise: Promise<void> | undefined;
const alive = (p: ChildProcess | undefined) =>
  !!p && p.exitCode === null && p.signalCode === null;
const send = (p: ChildProcess | undefined) => {
  if (p?.connected) p.send({ type: "shutdown" }, () => {});
};
const waitExit = (p: ChildProcess | undefined, ms: number) =>
  new Promise<boolean>((resolve) => {
    if (!alive(p)) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    p!.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
const cleanup = () => {
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      runtimeId: string;
    };
    if (metadata.runtimeId === runtimeId) unlinkSync(metadataPath);
  } catch {}
};
const shutdown = (failed = false) => {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    log.write(
      "runtime",
      failed ? "error" : "info",
      failed ? "组件退出，正在停止" : "正在停止",
    );
    send(worker);
    const workerDone = await waitExit(worker, 6500);
    send(hub);
    const hubDone = await waitExit(hub, 2000);
    cleanup();
    server.close();
    if (!workerDone || !hubDone) {
      log.write("runtime", "error", "等待超时，将关闭 Job Object");
      process.exit(1);
    }
    process.exitCode = failed ? 1 : 0;
  })();
  return shutdownPromise;
};
const server = createServer((socket) => {
  let raw = "";
  socket.setEncoding("utf8");
  socket.setTimeout(2000, () => socket.destroy());
  socket.on("data", (data) => {
    raw += data;
    if (raw.length > 4096) {
      socket.destroy();
      return;
    }
    if (!raw.includes("\n")) return;
    try {
      const req = JSON.parse(raw.slice(0, raw.indexOf("\n"))) as {
        token?: string;
        runtimeId?: string;
        operation?: string;
      };
      if (req.token !== token || req.runtimeId !== runtimeId) {
        socket.destroy();
        return;
      }
      if (req.operation === "status")
        socket.end(
          JSON.stringify({
            runtimeId,
            launcherPid: process.pid,
            hubPid: hub?.pid ?? null,
            workerPid: worker?.pid ?? null,
            hub: alive(hub) ? "running" : "unavailable",
            worker: alive(worker) ? "running" : "unavailable",
          }) + "\n",
        );
      else if (req.operation === "stop") {
        socket.end(JSON.stringify({ runtimeId, stopping: true }) + "\n");
        void shutdown();
      } else socket.destroy();
    } catch {
      socket.destroy();
    }
  });
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(pipe, () => {
    server.off("error", reject);
    resolve();
  });
});
writeFileSync(
  `${metadataPath}.tmp`,
  JSON.stringify({
    runtimeId,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
renameSync(`${metadataPath}.tmp`, metadataPath);
const port = Number(process.env.TASKCIRCUIT_PORT ?? 4317);
const busy = await new Promise<boolean>((resolve) => {
  const s = connect({ host: "127.0.0.1", port });
  s.once("connect", () => {
    s.destroy();
    resolve(true);
  });
  s.once("error", () => resolve(false));
  s.setTimeout(1000, () => {
    s.destroy();
    resolve(true);
  });
});
if (busy) {
  log.write("runtime", "error", `端口 ${port} 已被占用`);
  cleanup();
  server.close();
  process.exitCode = 1;
} else {
  const start = (name: "hub" | "worker") => {
    const configPath = join(root, "taskcircuit.config.json");
    const env = { ...process.env, TASKCIRCUIT_HOME: home };
    const child = fork(cli, [name], {
      cwd: root,
      env:
        name === "worker"
          ? workerEnvironment(
              existsSync(configPath) ? loadConfig(configPath) : defaultConfig,
              env,
            )
          : env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (!line) continue;
          try {
            const value = JSON.parse(line) as {
              component?: string;
              message?: string;
            };
            if (value.component === "notification")
              log.write("notification", "info", "本地通知已投递");
            else if (
              [
                "Hub 已启动",
                "开始执行",
                "执行结果已保存",
                "结果提交冲突",
                "结果回执冲突",
              ].includes(value.message ?? "")
            )
              log.write(name, "info", String(value.message));
            else log.write(name, "info", "组件运行记录");
          } catch {
            log.write(name, "info", "组件运行记录");
          }
        }
      });
    child.on("exit", (code) => {
      if (!stopping) {
        log.write("runtime", "error", `${name} 意外退出 (${code ?? "signal"})`);
        void shutdown(true);
      }
    });
    return child;
  };
  const ready = (child: ChildProcess) =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("组件启动超时")),
        15000,
      );
      child.on("message", (m: unknown) => {
        if (
          m &&
          typeof m === "object" &&
          (m as { type?: string }).type === "ready"
        ) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("组件启动失败"));
      });
    });
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  try {
    hub = start("hub");
    await ready(hub);
    worker = start("worker");
    await ready(worker);
    log.write("runtime", "info", "Runtime 已启动");
  } catch {
    log.write("runtime", "error", "Runtime 启动失败");
    await shutdown(true);
  }
}
