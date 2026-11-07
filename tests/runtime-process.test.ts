// Guards the supervisor from duplicate starts, stale metadata, orphaned components and silent component failure.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import {
  readRuntimeStatus,
  stopRuntime,
  waitStopped,
} from "../src/platform/windows/runtime.js";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(
  fn: () => Promise<T | null>,
  ms = 15000,
): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== null) return v;
    await delay(100);
  }
  throw Error("timeout");
};
const waitForExit = async (
  child: ReturnType<typeof spawn>,
  ms = 15000,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("process exit timeout")), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
describe.skipIf(process.platform !== "win32")("runtime supervisor", () => {
  it("recovers stale state, rejects duplicate, stops gracefully, and stops hub after worker failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-runtime-test-")),
      home = join(root, "state");
    mkdirSync(join(home, "runtime"), { recursive: true });
    writeFileSync(
      join(home, "runtime", "runtime.json"),
      JSON.stringify({
        runtimeId: "stale",
        token: "invalid",
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }),
    );
    const reservation = createServer();
    await new Promise<void>((r) => reservation.listen(0, "127.0.0.1", r));
    const address = reservation.address();
    if (!address || typeof address === "string") throw Error("port");
    const port = address.port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const ps = join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      job = join(process.cwd(), "scripts", "windows", "job.ps1"),
      launcher = join(
        process.cwd(),
        "dist",
        "platform",
        "windows",
        "launcher.js",
      );
    const launch = () =>
      spawn(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          job,
          "-Node",
          process.execPath,
          "-Launcher",
          launcher,
          "-RuntimeHome",
          home,
          "-AppDir",
          process.cwd(),
        ],
        {
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            TASKCIRCUIT_PORT: String(port),
            TASKCIRCUIT_WORKSPACE_ROOT: join(root, "work"),
          },
        },
      );
    let a = launch();
    let b: ReturnType<typeof launch> | undefined;
    try {
      const first = await until(async () => {
        const x = await readRuntimeStatus(home);
        return x.runtime === "running" &&
          x.hub === "running" &&
          x.worker === "running"
          ? x
          : null;
      });
      expect(first.runtimeId).not.toBe("stale");
      b = launch();
      await waitForExit(b);
      expect(b.exitCode).not.toBe(0);
      expect((await readRuntimeStatus(home)).runtimeId).toBe(first.runtimeId);
      await stopRuntime(home);
      await waitStopped(home);
      await waitForExit(a);
      expect(a.exitCode).toBe(0);
      expect(alive(Number(first.hubPid))).toBe(false);
      expect(alive(Number(first.workerPid))).toBe(false);
      a = launch();
      const next = await until(async () => {
        const x = await readRuntimeStatus(home);
        return x.runtime === "running" &&
          x.hub === "running" &&
          x.worker === "running"
          ? x
          : null;
      });
      process.kill(Number(next.workerPid));
      await waitForExit(a);
      expect(a.exitCode).not.toBe(0);
      expect(alive(Number(next.hubPid))).toBe(false);
    } finally {
      if (a.exitCode === null && a.signalCode === null) {
        a.kill();
        await waitForExit(a);
      }
      if (b && b.exitCode === null && b.signalCode === null) {
        b.kill();
        await waitForExit(b);
      }
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 45000);
});
