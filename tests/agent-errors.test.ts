// Prevent sensitive process output leaks and incorrect retry decisions for known agent failures.
import { describe, expect, it } from "vitest";
import { classifyAgentFailure } from "../src/agents/errors.js";
import { ProcessRunner } from "../src/agents/process.js";
import { CodexAdapter } from "../src/agents/codex/adapter.js";
import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import type { AgentExecutionInput } from "../src/adapter.js";

describe("agent failure classification", () => {
  for (const adapter of ["codex", "claude"] as const) {
    it.each([
      ["Usage limit reached. token=private-value", "quota_exceeded", false],
      ["You’ve hit your usage limit for Codex.", "quota_exceeded", false],
      ["HTTP 429 too many requests", "rate_limited", true],
      ["ECONNRESET while calling service", "agent_execution", true],
      ["Authentication failed: login required", "auth_failed", false],
      ["unrecognized failure: token=private-value", "agent_execution", false],
    ])("%s classifies %s safely", (message, code, retryable) => {
      const e = classifyAgentFailure(adapter, {
        exitCode: 1,
        stdout: "",
        stderr: message,
      });
      expect(e).toMatchObject({ code, retryable });
      expect(e.message).not.toContain("private-value");
    });
  }
  it.each(["codex", "claude"] as const)(
    "%s classifies actual adapter failures and malformed output",
    async (adapter) => {
      const input: AgentExecutionInput = {
        workItemId: "w",
        executionId: "e",
        workingDirectory: ".",
        instruction: "",
        context: null,
        previousAnswers: [],
        externalSessionId: null,
      };
      const fake = (exitCode: number, stdout: string, stderr: string) => ({
        run: async () => ({ exitCode, stdout, stderr }),
      });
      const make = (runner: ReturnType<typeof fake>) =>
        adapter === "codex"
          ? new CodexAdapter(runner, { executable: "fake", prefix: [] })
          : new ClaudeAdapter(runner, { executable: "fake", prefix: [] });
      await expect(
        make(fake(1, "", "quota exceeded secret-content")).execute(input),
      ).rejects.toMatchObject({ code: "quota_exceeded", retryable: false });
      await expect(
        make(fake(0, "not-json", "")).execute(input),
      ).rejects.toMatchObject({ code: "agent_protocol", retryable: false });
      await expect(
        make(fake(1, "", "unexpected error")).execute(input),
      ).rejects.toMatchObject({ code: "agent_execution", retryable: false });
    },
  );
  it("classifies missing executables and timeouts without retries for missing CLIs", async () => {
    const r = new ProcessRunner();
    const spec = {
      executable: "taskcircuit-nonexistent-agent-command",
      args: [],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
    };
    await expect(r.run(spec)).rejects.toMatchObject({
      code: "agent_unavailable",
      retryable: false,
    });
    await expect(
      r.run({
        ...spec,
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        timeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "agent_timeout", retryable: true });
  });
});
