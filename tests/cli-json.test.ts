// Prevent CLI JSON mode from mixing text, truncating IDs, or disclosing external sessions.
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
const run = promisify(execFile);
describe("CLI JSON mode", () => {
  it("returns parseable complete IDs for status, work and inbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-cli-json-"));
    const hub = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const base = await hub.listen({ port: 0, host: "127.0.0.1" });
      const response = await hub.inject({
        method: "POST",
        url: "/api/events",
        payload: { source: "local", type: "demo.color", payload: {} },
      });
      const id = response.json().workItem.id;
      await workOnce(base, "cli-test");
      const env = {
        ...process.env,
        TASKCIRCUIT_PORT: new URL(base).port,
        TASKCIRCUIT_HOME: dir,
      };
      const cli = async (...args: string[]) =>
        (
          await run(process.execPath, ["dist/cli.js", ...args], {
            env,
            encoding: "utf8",
            windowsHide: true,
          })
        ).stdout;
      const parse = async (...args: string[]) => {
        const out = await cli(...args, "--json");
        expect(out).not.toMatch(/\x1b\[/);
        return JSON.parse(out);
      };
      expect((await parse("status"))[0].workItem.id).toBe(id);
      const detail = await parse("work", id);
      expect(detail.workItem.id).toBe(id);
      expect(detail.agentSession.externalSessionId).toBe("present");
      const inbox = await parse("inbox");
      expect(inbox[0].workItemId).toBe(id);
      expect(inbox[0].interactionId).toBe(detail.interactions[0].id);
      expect(await cli("status")).toContain("TaskCircuit Work Items");
      expect(await cli("inbox")).toContain("Answer with:");
      expect(await parse("doctor")).toHaveProperty("sqlite");
      if (process.platform === "win32")
        expect(await parse("runtime", "status")).toHaveProperty(
          "windowsStartupTask",
        );
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
