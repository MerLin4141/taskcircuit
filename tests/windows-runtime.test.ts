// Guards task naming, process ownership, stale metadata and orderly shutdown of the Windows runtime.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { RuntimeLog } from "../src/platform/windows/log.js";
import { taskName } from "../src/platform/windows/task.js";
import {
  readRuntimeStatus,
  stopRuntime,
  portOccupied,
} from "../src/platform/windows/runtime.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "./fixtures/g2-hub.js";
import { defaultConfig } from "../src/config.js";

describe("Windows runtime contract", () => {
  it("keeps default task name stable and hashes custom home", () => {
    expect(
      taskName(
        "C:\\workspace\\user\\.taskcircuit",
        "C:\\workspace\\user\\.taskcircuit",
      ),
    ).toBe("TaskCircuit");
    const name = taskName(
      "C:\\some private\\other",
      "C:\\workspace\\user\\.taskcircuit",
    );
    expect(name).toMatch(/^TaskCircuit-[0-9a-f]{8}$/);
    expect(name).not.toContain("private");
    expect(
      taskName("C:\\some private\\other", "C:\\workspace\\user\\.taskcircuit"),
    ).toBe(name);
  });
  it("does not mistake stale metadata for a running instance or kill an unrelated pid", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-stale-"));
    try {
      mkdirSync(join(home, "runtime"));
      writeFileSync(
        join(home, "runtime", "runtime.json"),
        JSON.stringify({
          runtimeId: "stale",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00Z",
          token: "invalid",
        }),
      );
      const result = await readRuntimeStatus(home);
      expect(result.runtime).toBe("stale");
      await expect(stopRuntime(home)).rejects.toThrow();
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("tracks worker heartbeats without emitting runtime changes and identifies stale workers", async () => {
    let t = Date.parse("2026-01-01T00:00:00Z");
    const hub = createHub(":memory:", defaultConfig, () => t, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const head = (await hub.inject("/api/stream/head")).json().sequence;
      expect(
        (
          await hub.inject({
            method: "POST",
            url: "/api/workers/w/heartbeat",
            payload: { status: "online" },
          })
        ).statusCode,
      ).toBe(200);
      expect((await hub.inject("/api/workers")).json()[0].state).toBe("online");
      expect((await hub.inject("/api/stream/head")).json().sequence).toBe(head);
      t += 31000;
      expect((await hub.inject("/api/workers")).json()[0].state).toBe("stale");
    } finally {
      await hub.close();
    }
  });
  it("rotates runtime logs without storing raw environment", () => {
    const home = mkdtempSync(join(tmpdir(), "tc-log-"));
    try {
      const log = new RuntimeLog(home, 150, 2);
      for (let i = 0; i < 8; i++) log.write("runtime", "info", "运行记录");
      expect(existsSync(join(home, "logs", "runtime.log.1"))).toBe(true);
      expect(existsSync(join(home, "logs", "runtime.log.3"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== "win32")(
    "closes the Job Object and kills contained descendants without affecting an unrelated process",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tc-job-test-"));
      const ps = join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const job = join(process.cwd(), "scripts", "windows", "job.ps1");
      const fixture = join(process.cwd(), "tests", "fixtures", "job-child.mjs");
      const unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore", windowsHide: true },
      );
      const helper = spawn(
        ps,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          job,
          "-Node",
          process.execPath,
          "-Launcher",
          fixture,
          "-RuntimeHome",
          dir,
          "-AppDir",
          process.cwd(),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        let ids: { parent: number; child: number } | undefined;
        for (let i = 0; i < 100; i++) {
          if (existsSync(join(dir, "ids.json"))) {
            ids = JSON.parse(readFileSync(join(dir, "ids.json"), "utf8"));
            break;
          }
          if (helper.exitCode !== null) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        expect(ids).toBeDefined();
        expect(alive(ids!.parent)).toBe(true);
        expect(alive(ids!.child)).toBe(true);
        helper.kill();
        await new Promise<void>((r) => helper.once("exit", () => r()));
        for (
          let i = 0;
          i < 100 && (alive(ids!.parent) || alive(ids!.child));
          i++
        )
          await new Promise((r) => setTimeout(r, 50));
        expect(alive(ids!.parent)).toBe(false);
        expect(alive(ids!.child)).toBe(false);
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        if (helper.exitCode === null) helper.kill();
        if (unrelated.exitCode === null) unrelated.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20000,
  );
  it("detects an occupied port without affecting its owner", async () => {
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("port");
    try {
      expect(await portOccupied(address.port)).toBe(true);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("upgrades a Phase 4 database without losing work or stream records", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-upgrade4-"));
    const dbpath = join(root, "state.db");
    let hub = createHub(dbpath, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const r = await hub.inject({
        method: "POST",
        url: "/api/events",
        payload: { source: "local", type: "demo.color", payload: {} },
      });
      const work = r.json().workItem.id;
      const head = (await hub.inject("/api/stream/head")).json().sequence;
      await hub.close();
      const db = new DatabaseSync(dbpath);
      db.exec(
        "DROP TABLE worker_presence; DELETE FROM schema_migrations WHERE version=4",
      );
      db.close();
      hub = createHub(dbpath, defaultConfig, undefined, 0, {
        dispatcherPollMs: 0,
      });
      expect(
        (await hub.inject(`/api/work-items/${work}`)).json().workItem.status,
      ).toBe("active");
      expect((await hub.inject("/api/stream/head")).json().sequence).toBe(head);
      expect((await hub.inject("/api/workers")).json()).toEqual([]);
    } finally {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
