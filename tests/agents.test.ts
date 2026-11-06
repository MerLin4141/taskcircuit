// Guards agent output validation, process isolation, and safe CLI session resume.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner } from "../src/agents/process.js";
import { agentEnvironment } from "../src/agents/environment.js";
import { parseResponse } from "../src/agents/protocol.js";
import { CodexAdapter } from "../src/agents/codex/adapter.js";
import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import type { AgentExecutionInput } from "../src/adapter.js";

const input: AgentExecutionInput = {
  workItemId: "work",
  executionId: "execution",
  externalSessionId: null,
  workingDirectory: ".",
  instruction: "选择颜色",
  context: { hello: "data" },
  previousAnswers: [],
};
describe("agent boundary", () => {
  it("validates the output contract", () => {
    expect(
      parseResponse(
        '{"kind":"ask","message":"请选择","interaction":{"title":"颜色","text":"请选择","key":"color","options":["蓝色"]}}',
      ).kind,
    ).toBe("ask");
    expect(parseResponse('{"kind":"complete","message":"完成"}').kind).toBe(
      "complete",
    );
    for (const value of [
      "not json",
      "```json\n{}\n```",
      "{}",
      '{"kind":"ask","message":"x","interaction":{"title":"x","text":"x","key":"","options":[]}}',
    ])
      expect(() => parseResponse(value)).toThrow();
  });
  it("rejects empty options and an empty interaction key independently", () => {
    const question = {
      kind: "ask",
      message: "选择",
      interaction: {
        title: "颜色",
        text: "请选择",
        key: "color",
        options: [] as string[],
      },
    };
    expect(() => parseResponse(JSON.stringify(question))).toThrow();
    question.interaction.options = ["蓝色"];
    question.interaction.key = "";
    expect(() => parseResponse(JSON.stringify(question))).toThrow();
  });
  it("filters codex marker case insensitively without changing claude", () => {
    const env = {
      PATH: "path",
      USERPROFILE: "profile",
      codex_windows_registered_core: "1",
      TASKCIRCUIT_SECRET: "secret",
    };
    expect(agentEnvironment(env, "codex")).toEqual({
      PATH: "path",
      USERPROFILE: "profile",
    });
    expect(agentEnvironment(env, "claude")).toEqual({
      PATH: "path",
      USERPROFILE: "profile",
      codex_windows_registered_core: "1",
    });
  });
  it("runs argv without shell and captures cwd, env, exit code and stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-run-"));
    const runner = new ProcessRunner();
    const res = await runner.run({
      executable: process.execPath,
      args: [
        "-e",
        'process.stderr.write("err");console.log(JSON.stringify([process.cwd(),process.env.TC_TEST,process.argv[1]]));process.exit(7)',
        "a;echo injected",
      ],
      cwd: dir,
      env: { ...process.env, TC_TEST: "value" },
      timeoutMs: 5000,
    });
    expect(res.exitCode).toBe(7);
    expect(res.stderr).toBe("err");
    expect(JSON.parse(res.stdout)).toEqual([dir, "value", "a;echo injected"]);
    rmSync(dir, { recursive: true, force: true });
  });
  it("terminates on timeout and abort", async () => {
    const runner = new ProcessRunner();
    const spec = {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 50,
    };
    await expect(runner.run(spec)).rejects.toThrow();
    const ctrl = new AbortController();
    const pending = runner.run({
      ...spec,
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(pending).rejects.toThrow();
  });
  it.each(["codex", "claude"] as const)(
    "%s translates new and resume sessions",
    async (kind) => {
      const calls: string[][] = [];
      const fake = {
        run: async (spec: { args: string[] }) => {
          calls.push(spec.args);
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              kind === "codex"
                ? '{"type":"thread.started","thread_id":"external"}\n{"type":"item.completed","item":{"type":"agent_message","text":"{\\"kind\\":\\"complete\\",\\"message\\":\\"ok\\"}"}}\n'
                : '{"session_id":"external","result":"{\\"kind\\":\\"complete\\",\\"message\\":\\"ok\\"}"}',
          };
        },
      };
      const adapter =
        kind === "codex"
          ? new CodexAdapter(fake, { executable: "fake", prefix: [] })
          : new ClaudeAdapter(fake, { executable: "fake", prefix: [] });
      const first = await adapter.execute(input);
      expect(first).toMatchObject({
        type: "completed",
        sessionId: "external",
        output: "ok",
      });
      const second = await adapter.execute({
        ...input,
        externalSessionId: "external",
      });
      expect(second).toMatchObject({
        type: "completed",
        sessionId: "external",
      });
      expect(calls[1]).toContain(kind === "codex" ? "resume" : "--resume");
      expect(calls[1]).toContain("external");
    },
  );
  it("detects required CLI help capabilities", async () => {
    const { supportsCli } = await import("../src/agents/capability.js");
    expect(supportsCli("codex", "resume --json")).toBe(true);
    expect(supportsCli("codex", "resume")).toBe(false);
    expect(supportsCli("claude", "--print --output-format --resume")).toBe(
      true,
    );
  });
  it.each(["codex", "claude"] as const)(
    "%s runs a fake executable and resumes it",
    async (kind) => {
      const command = {
        executable: process.execPath,
        prefix: [join(process.cwd(), "tests", "fixtures", "agent.cjs")],
      };
      const adapter =
        kind === "codex"
          ? new CodexAdapter(new ProcessRunner(), command)
          : new ClaudeAdapter(new ProcessRunner(), command);
      expect(await adapter.execute(input)).toMatchObject({
        type: "completed",
        sessionId: "fixture-id",
      });
      expect(
        await adapter.execute({
          ...input,
          externalSessionId: "fixture-id",
        }),
      ).toMatchObject({ type: "completed", sessionId: "fixture-id" });
    },
  );
});
