// Guards fake CLI output compatibility, capability detection, and conservative errors without external services.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CodexAdapter } from "../src/agents/codex/adapter.js";
import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import { ProcessRunner, type Runner } from "../src/agents/process.js";
import { detectCli, supportsCli } from "../src/agents/capability.js";
import { classifyAgentFailure } from "../src/agents/errors.js";
import type { AgentExecutionInput } from "../src/adapter.js";

const root = join(process.cwd(), "tests", "fixtures", "p2");
const fixture = join(root, "protocol-cases.json");
const data = JSON.parse(readFileSync(fixture, "utf8"));
const input: AgentExecutionInput = {
  workItemId: "work",
  executionId: "execution",
  externalSessionId: null,
  workingDirectory: process.cwd(),
  instruction: "fixture",
  context: {},
  previousAnswers: [],
};
const command = (kind: string, scenario: string) => ({
  executable: process.execPath,
  prefix: [join(root, "fake-cli.mjs"), fixture, kind, scenario],
});
function adapter(
  kind: "codex" | "claude",
  scenario: string,
  runner: Runner = new ProcessRunner(),
) {
  const cmd = command(kind, scenario);
  return kind === "codex"
    ? new CodexAdapter(runner, cmd)
    : new ClaudeAdapter(runner, cmd);
}
describe("P2 fake CLI process protocol", () => {
  for (const kind of ["codex", "claude"] as const) {
    it(`${kind} starts and resumes the same fake session with valid output`, async () => {
      const a = adapter(kind, "valid");
      expect(await a.execute(input)).toEqual({
        type: "completed",
        sessionId: "fake-session",
        output: "fixture done",
      });
      expect(
        await a.execute({ ...input, externalSessionId: "fake-session" }),
      ).toEqual({
        type: "completed",
        sessionId: "fake-session",
        output: "fixture done",
      });
    });
    for (const scenario of [
      "malformed",
      "truncated",
      "empty",
      "missing_session",
      "missing_message",
    ])
      it(`${kind} ${scenario} returns protocol error`, async () => {
        await expect(
          adapter(kind, scenario).execute(input),
        ).rejects.toMatchObject({
          code: "agent_protocol",
          retryable: false,
          outcomeUnknown: true,
        });
      });
    it(`${kind} translates Ask and then resumes the same session`, async () => {
      const ask = await adapter(kind, "ask").execute(input);
      expect(ask).toMatchObject({
        type: "needs_input",
        sessionId: "fake-session",
        request: { key: "choice", options: ["yes"] },
      });
      const resumed = await adapter(kind, "valid").execute({
        ...input,
        externalSessionId: "fake-session",
        previousAnswers: [{ question: "choice", answer: "yes" }],
      });
      expect(resumed).toMatchObject({
        type: "completed",
        sessionId: "fake-session",
      });
    });
    it.each(["continue", "stop"])(
      `${kind} maps fake %s feedback without losing the session`,
      async (scenario) => {
        expect(await adapter(kind, scenario).execute(input)).toEqual({
          type: scenario,
          sessionId: "fake-session",
          message: "fixture feedback",
        });
      },
    );
    it(`${kind} fake session can report Continue twice then Complete`, async () => {
      const first = await adapter(kind, "continue").execute(input);
      const second = await adapter(kind, "continue").execute({
        ...input,
        externalSessionId: "fake-session",
      });
      const third = await adapter(kind, "valid").execute({
        ...input,
        externalSessionId: "fake-session",
      });
      expect([first.type, second.type, third.type]).toEqual([
        "continue",
        "continue",
        "completed",
      ]);
      expect([first.sessionId, second.sessionId, third.sessionId]).toEqual([
        "fake-session",
        "fake-session",
        "fake-session",
      ]);
    });
    it(`${kind} maps Later while preserving the session`, async () => {
      expect(await adapter(kind, "later").execute(input)).toEqual({
        type: "later",
        sessionId: "fake-session",
        message: "fixture later",
        afterSeconds: 2,
      });
    });
    it(`${kind} rejects malformed feedback`, async () => {
      await expect(
        adapter(kind, "invalid-feedback").execute(input),
      ).rejects.toMatchObject({ code: "agent_protocol", outcomeUnknown: true });
    });
    it(`${kind} preserves reported-failure cause as an unknown outcome`, async () => {
      expect(await adapter(kind, "fail").execute(input)).toMatchObject({
        type: "failed",
        error: {
          code: "execution_outcome_unknown",
          causeCode: "agent_reported_failure",
          retryable: false,
        },
      });
    });
    it.each([
      ["rate", "rate_limited", true],
      ["quota", "quota_exceeded", false],
      ["auth", "auth_failed", false],
      ["environment", "agent_environment", false],
    ])(
      `${kind} fake process %s failure preserves conservative outcome`,
      async (scenario, code, retryable) => {
        await expect(
          adapter(kind, `error-${scenario}`).execute(input),
        ).rejects.toMatchObject({ code, retryable, outcomeUnknown: true });
      },
    );
    it(`${kind} rejects a different resume session`, async () => {
      await expect(
        adapter(kind, "mismatch").execute({
          ...input,
          externalSessionId: "fake-session",
        }),
      ).rejects.toMatchObject({ code: "agent_protocol", outcomeUnknown: true });
    });
    it(`${kind} handles non-zero exit without disclosing stderr`, async () => {
      try {
        await adapter(kind, "nonzero").execute(input);
        expect.fail("nonzero must fail");
      } catch (e) {
        expect(e).toMatchObject({
          code: "agent_execution",
          outcomeUnknown: true,
        });
        expect(String(e)).not.toContain("unrecognized provider failure");
      }
    });
    it(`${kind} treats timeout after process launch as unknown`, async () => {
      const real = new ProcessRunner();
      const short: Runner = {
        run: (spec) => real.run({ ...spec, timeoutMs: 150 }),
      };
      await expect(
        adapter(kind, "hang", short).execute(input),
      ).rejects.toMatchObject({
        code: "agent_timeout",
        retryable: false,
        outcomeUnknown: true,
      });
    });
    it(`${kind} propagates cancellation to a running fake CLI`, async () => {
      const real = new ProcessRunner();
      const ctrl = new AbortController();
      let started!: () => void;
      const ready = new Promise<void>((r) => (started = r));
      const runner: Runner = {
        run: (spec) => {
          const p = real.run(spec);
          started();
          return p;
        },
      };
      const running = adapter(kind, "hang", runner).execute(input, ctrl.signal);
      await ready;
      setTimeout(() => ctrl.abort(), 150);
      await expect(running).rejects.toMatchObject({
        code: "agent_execution",
        outcomeUnknown: true,
      });
    });
    it(`${kind} handles a signal-like null exit code conservatively`, async () => {
      const runner: Runner = {
        run: async () => ({ exitCode: null, stdout: "", stderr: "" }),
      };
      await expect(
        adapter(kind, "valid", runner).execute(input),
      ).rejects.toMatchObject({
        code: "agent_execution",
        outcomeUnknown: true,
      });
    });
  }
  it("codex accepts intermediate and unknown JSONL events", async () => {
    expect(await adapter("codex", "valid").execute(input)).toMatchObject({
      type: "completed",
    });
  });
  it("codex rejects intermediate events without a final message", async () => {
    await expect(
      adapter("codex", "intermediate").execute(input),
    ).rejects.toMatchObject({ code: "agent_protocol" });
  });
  it("claude rejects empty session identifiers", async () => {
    await expect(
      adapter("claude", "empty_session").execute(input),
    ).rejects.toMatchObject({ code: "agent_protocol" });
  });
  it("claude classifies an error status rather than treating it as success", async () => {
    await expect(
      adapter("claude", "is_error").execute(input),
    ).rejects.toMatchObject({ code: "agent_execution", outcomeUnknown: true });
  });
});
describe("P2 error classification and capabilities", () => {
  for (const kind of ["codex", "claude"] as const) {
    it.each([
      ["quota", "quota_exceeded", false],
      ["rate", "rate_limited", true],
      ["auth", "auth_failed", false],
      ["environment", "agent_environment", false],
      ["unknown", "agent_execution", false],
    ])(`${kind} classifies %s`, (scenario, code, retryable) => {
      const e = classifyAgentFailure(kind, {
        exitCode: 1,
        stdout: "",
        stderr: data.errors[scenario] + " synthetic-private-marker",
      });
      expect(e).toMatchObject({ code, retryable });
      expect(e.message).not.toContain("synthetic-private-marker");
    });
    it(`${kind} rejects a capability probe that reports an unknown option on stderr`, async () => {
      const runner: Runner = {
        run: async () => ({
          exitCode: 0,
          stdout: data.help[kind],
          stderr: "error: unknown option --resume",
        }),
      };
      expect(
        await detectCli(kind, runner, process.cwd(), command(kind, "help")),
      ).toBe(false);
    });
    it(`${kind} detects a fake supported help response`, async () => {
      expect(
        await detectCli(
          kind,
          new ProcessRunner(),
          process.cwd(),
          command(kind, "help"),
        ),
      ).toBe(true);
    });
    it(`${kind} does not default to supported on an unknown-option error`, () => {
      expect(
        supportsCli(kind, `error: unknown option --resume\n${data.help[kind]}`),
      ).toBe(false);
    });
    it(`${kind} reports missing executable`, async () => {
      await expect(
        detectCli(kind, new ProcessRunner(), process.cwd(), {
          executable: "taskcircuit-nonexistent-fake-cli",
          prefix: [],
        }),
      ).rejects.toMatchObject({ code: "agent_unavailable" });
    });
    it(`${kind} reports a timed out capability probe`, async () => {
      const real = new ProcessRunner();
      const short: Runner = {
        run: (spec) => real.run({ ...spec, timeoutMs: 100 }),
      };
      await expect(
        detectCli(kind, short, process.cwd(), command(kind, "hang")),
      ).rejects.toMatchObject({ code: "agent_timeout" });
    });
  }
  it("rejects incomplete help and version-only output", () => {
    expect(supportsCli("codex", "codex 1.2.3 --json")).toBe(false);
    expect(supportsCli("claude", "claude 9.8.7 --print --output-format")).toBe(
      false,
    );
  });
  it("preserves resume error classification", () => {
    expect(
      classifyAgentFailure(
        "codex",
        { exitCode: 1, stdout: "", stderr: "unrecognized" },
        true,
      ),
    ).toMatchObject({ code: "agent_resume", retryable: false });
  });
});
