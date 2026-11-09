// Guards the complete adapter-to-worker-to-scheduler error and notification path.
import { describe, expect, it } from "vitest";
import { createHub } from "./fixtures/g2-hub.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
import { CodexAdapter } from "../src/agents/codex/adapter.js";
import { ClaudeAdapter } from "../src/agents/claude/adapter.js";

describe("agent error integration", () => {
  for (const kind of ["codex", "claude"] as const) {
    it.each([
      ["quota exceeded", "quota_exceeded", "failed"],
      ["HTTP 429 too many requests", "rate_limited", "failed"],
      ["authentication failed", "auth_failed", "failed"],
    ])("%s persists and routes %s", async (output, code, status) => {
      const hub = createHub(":memory:", defaultConfig, undefined, 0, {
        dispatcherPollMs: 0,
      });
      try {
        const base = await hub.listen({ port: 0, host: "127.0.0.1" });
        const event = await hub.inject({
          method: "POST",
          url: "/api/events",
          payload: { source: "local", type: "demo.retry", payload: {} },
        });
        const id = event.json().workItem.id;
        const runner = {
          run: async () => ({
            exitCode: 1,
            stdout: "",
            stderr: output + " secret-value",
          }),
        };
        const adapter =
          kind === "codex"
            ? new CodexAdapter(runner, { executable: "fake", prefix: [] })
            : new ClaudeAdapter(runner, { executable: "fake", prefix: [] });
        expect(await workOnce(base, "test-worker", adapter)).toBe(true);
        const detail = (await hub.inject(`/api/work-items/${id}`)).json();
        expect(detail.workItem.status).toBe(status);
        expect(detail.executions[0].error.code).toBe(
          "execution_outcome_unknown",
        );
        expect(detail.executions[0].error.causeCode).toBe(code);
        expect(detail.executions[0].error.retryable).toBe(false);
        expect(detail.schedules).toHaveLength(0);
        expect(JSON.stringify(detail)).not.toContain("secret-value");
        if (status === "failed")
          expect(
            (await hub.inject("/api/notifications")).json()[0].body,
          ).not.toContain("secret-value");
      } finally {
        await hub.close();
      }
    });
  }
});
