// Guards receipt recovery after a Worker dies between COMMIT and response delivery.
import { describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";

describe("result receipt after process crash", () => {
  it("reads a committed receipt after killing the Worker and restarting the Hub", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-p1-crash-"));
    const db = join(root, "db");
    let time = Date.parse("2026-01-01T00:00:00Z");
    let hub = createHub(db, defaultConfig, () => time, 0, {
      dispatcherPollMs: 0,
    });
    let child: ChildProcess | undefined;
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      const created = (
        await hub.inject({
          method: "POST",
          url: "/api/events",
          payload: {
            source: "local",
            type: "demo.retry",
            payload: {},
          },
        })
      ).json();
      child = fork(
        join(process.cwd(), "tests", "fixtures", "p1-worker.mjs"),
        [base],
        {
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          env: {
            ...process.env,
            TASKCIRCUIT_HOME: join(root, "home"),
            TASKCIRCUIT_WORKSPACE_ROOT: join(root, "workspace"),
          },
        },
      );
      let calls = 0;
      const receipt = await new Promise<{
        status: number;
        submissionId: string;
        digest: string;
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("worker commit timed out")),
          5000,
        );
        child!.on("message", (message: any) => {
          if (message.type === "agent-called") calls++;
          if (message.type === "committed") {
            clearTimeout(timer);
            resolve(message);
          }
        });
        child!.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child!.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("worker exited before commit"));
        });
      });
      expect(receipt.status).toBe(200);
      expect(calls).toBe(1);
      await new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
        child!.kill();
      });
      time += 31000;
      await hub.close();
      hub = createHub(db, defaultConfig, () => time, 0, {
        dispatcherPollMs: 0,
      });
      const confirm = await hub.inject(
        `/api/executions/${created.execution.id}/result-submissions/${receipt.submissionId}?digest=${receipt.digest}`,
      );
      expect(confirm.statusCode).toBe(200);
      expect(confirm.json().status).toBe("committed");
      expect(
        (
          await hub.inject({
            method: "POST",
            url: "/api/executions/claim",
            payload: { workerId: "new" },
          })
        ).statusCode,
      ).toBe(204);
      const state = (
        await hub.inject(`/api/work-items/${created.workItem.id}`)
      ).json();
      expect(state.workItem.status).toBe("completed");
      expect(state.executions).toHaveLength(1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          child!.once("exit", () => resolve());
          child!.kill();
        });
      }
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
