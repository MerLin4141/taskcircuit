// Guards against two processors creating duplicate continuations after a committed result.
import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { join } from "node:path";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { workOnce } from "../src/worker.js";
it("independent continuation processors create exactly one successor", async () => {
  const f = await setupLoop(3, 120);
  try {
    expect(
      await workOnce(f.base, "w", {
        async execute() {
          return { type: "continue", sessionId: "fake", message: "next" };
        },
      }),
    ).toBe(true);
    const parent = String(
      f.db.prepare("SELECT id FROM executions ORDER BY sequence LIMIT 1").get()
        ?.id,
    );
    const configFile = join(f.home, "config.json");
    writeFileSync(configFile, JSON.stringify(f.config));
    const children = [1, 2].map(() =>
      fork(
        join(process.cwd(), "tests/fixtures/phase5-continuation-race.mjs"),
        [f.path, configFile, parent, "2026-01-01T00:00:00.000Z"],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      ),
    );
    try {
      const results = await Promise.all(
        children.map(
          (c) =>
            new Promise<any>((resolve, reject) => {
              const timer = setTimeout(() => reject(Error("timeout")), 10000);
              c.on("message", (m) => {
                if (m === "ready") c.send("go");
                else {
                  clearTimeout(timer);
                  resolve(m);
                }
              });
              c.once("error", reject);
            }),
        ),
      );
      expect(results.every((x) => x.result)).toBe(true);
      expect(
        f.db
          .prepare(
            "SELECT COUNT(*) n FROM executions WHERE parent_execution_id=? AND trigger_kind='continue'",
          )
          .get(parent)?.n,
      ).toBe(1);
    } finally {
      for (const c of children) if (c.exitCode === null && !c.killed) c.kill();
    }
  } finally {
    await f.close();
  }
});

it("rolls back a killed continuation writer and recovers exactly once", async () => {
  const f = await setupLoop(3, 120);
  try {
    expect(
      await workOnce(f.base, "first", {
        async execute() {
          return { type: "continue", sessionId: "fake", message: "next" };
        },
      }),
    ).toBe(true);
    const parent = String(
      f.db.prepare("SELECT id FROM executions ORDER BY sequence LIMIT 1").get()
        ?.id,
    );
    const configFile = join(f.home, "kill-config.json");
    writeFileSync(configFile, JSON.stringify(f.config));
    const child = fork(
      join(process.cwd(), "tests/fixtures/phase5-continuation-kill.mjs"),
      [f.path, configFile, parent, "2026-01-01T00:00:00.000Z"],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("timeout")), 10000);
        child.on("message", (m) => {
          if (m === "successor-inserted") {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error("early exit"));
        });
      });
      const done = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await done;
      expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
        1,
      );
      expect(
        await workOnce(f.base, "next", {
          async execute(input) {
            expect(input.externalSessionId).toBe("fake");
            return { type: "completed", sessionId: "fake", output: "done" };
          },
        }),
      ).toBe(true);
      expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
        2,
      );
      expect(await workOnce(f.base, "other")).toBe(false);
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  } finally {
    await f.close();
  }
});
