import { fork } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
// Guards automatic continuation recovery after lost responses and Hub restarts.
import { it, expect } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { workOnce } from "../src/worker.js";
it("recovers one committed Continue after Hub restart", async () => {
  const f = await setupLoop(3, 120);
  try {
    let calls = 0;
    const adapter = {
      async execute() {
        calls++;
        return calls === 1
          ? { type: "continue" as const, sessionId: "fake", message: "next" }
          : { type: "completed" as const, sessionId: "fake", output: "done" };
      },
    };
    expect(await workOnce(f.base, "w", adapter)).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(1);
    await f.restart();
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(2);
    expect(await workOnce(f.base, "w", adapter)).toBe(true);
    await f.restart();
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(2);
    expect(calls).toBe(2);
  } finally {
    await f.close();
  }
});
it("reconciles a lost Continue receipt without rerunning its Agent", async () => {
  const f = await setupLoop(3, 120);
  const original = globalThis.fetch;
  let dropped = false,
    calls = 0,
    queries = 0;
  try {
    globalThis.fetch = async (...args) => {
      const url = String(args[0]);
      if (url.includes("/result-submissions/")) queries++;
      if (url.endsWith("/result") && !dropped) {
        dropped = true;
        await original(...args);
        throw Error("lost");
      }
      return original(...args);
    };
    const adapter = {
      async execute() {
        calls++;
        return calls === 1
          ? { type: "continue" as const, sessionId: "fake", message: "next" }
          : { type: "completed" as const, sessionId: "fake", output: "done" };
      },
    };
    expect(await workOnce(f.base, "w", adapter)).toBe(true);
    expect(queries).toBeGreaterThan(0);
    expect(await workOnce(f.base, "w", adapter)).toBe(true);
    expect(calls).toBe(2);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(2);
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

it("does not re-execute after an autonomous Worker dies after a fake side effect", async () => {
  const f = await setupLoop(3, 120);
  const marker = join(f.home, "side-effect.txt");
  try {
    const child = fork(
      join(process.cwd(), "tests/fixtures/phase5-worker-kill.mjs"),
      [f.base, marker],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, TASKCIRCUIT_HOME: join(f.home, "state") },
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("worker timeout")), 10000);
        child.on("message", (m: any) => {
          if (m.type === "agent-started") {
            clearTimeout(timer);
            resolve();
          } else if (m.type === "error") {
            clearTimeout(timer);
            reject(Error(m.message));
          }
        });
        child.once("error", reject);
      });
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exited;
      expect(readFileSync(marker, "utf8")).toBe("started");
      f.advance(31000);
      expect(
        (
          await f.hub.inject({
            method: "POST",
            url: "/api/executions/claim",
            payload: { workerId: "other" },
          })
        ).statusCode,
      ).toBe(204);
      const e = f.db.prepare("SELECT status,error FROM executions").get()!;
      expect(JSON.parse(String(e.error)).code).toBe(
        "execution_outcome_unknown",
      );
      expect(
        f.db
          .prepare("SELECT status FROM automation_roots WHERE id=?")
          .get(f.ev.rootId)?.status,
      ).toBe("blocked");
      expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
        1,
      );
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  } finally {
    await f.close();
  }
});
