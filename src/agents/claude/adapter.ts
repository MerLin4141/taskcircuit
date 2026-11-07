import type { AgentAdapter, AgentExecutionInput } from "../../adapter.js";
import type { AgentResult } from "../../domain.js";
import { AgentProtocolError, classifyAgentFailure } from "../errors.js";
import { agentEnvironment } from "../environment.js";
import { parseResponse, prompt } from "../protocol.js";
import { ProcessRunner, type Runner } from "../process.js";
import { resolveCli, type Executable } from "../capability.js";
export class ClaudeAdapter implements AgentAdapter {
  constructor(
    private runner: Runner = new ProcessRunner(),
    private command?: Executable,
  ) {}
  async execute(input: AgentExecutionInput): Promise<AgentResult> {
    const cmd = this.command ?? resolveCli("claude");
    const previous = input.externalSessionId;
    const args = ["--print", "--output-format", "json"];
    if (previous) args.push("--resume", previous);
    if (input.model) args.push("--model", input.model);
    const result = await this.runner.run({
      executable: cmd.executable,
      args: [...cmd.prefix, ...args],
      cwd: input.workingDirectory,
      env: agentEnvironment(process.env, "claude"),
      stdin: prompt(input),
      timeoutMs: 300000,
    });
    if (result.exitCode !== 0)
      throw classifyAgentFailure("claude", result, !!previous);
    let data: unknown;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw new AgentProtocolError();
    }
    if (!data || typeof data !== "object") throw new AgentProtocolError();
    const value = data as Record<string, unknown>;
    if (value.is_error === true)
      throw classifyAgentFailure("claude", result, !!previous);
    if (
      typeof value.session_id !== "string" ||
      typeof value.result !== "string" ||
      (previous && value.session_id !== previous)
    )
      throw new AgentProtocolError();
    const parsed = parseResponse(value.result);
    if (parsed.kind === "later")
      return {
        type: "later",
        sessionId: value.session_id as string,
        message: parsed.message,
        ...(parsed.afterSeconds !== undefined
          ? { afterSeconds: parsed.afterSeconds }
          : { runAt: parsed.runAt }),
      };
    if (parsed.kind === "ask")
      return {
        type: "needs_input",
        sessionId: value.session_id,
        request: parsed.interaction,
      };
    if (parsed.kind === "complete")
      return {
        type: "completed",
        sessionId: value.session_id,
        output: parsed.message,
      };
    return {
      type: "failed",
      sessionId: value.session_id as string,
      error: {
        code: "agent_reported_failure",
        message: parsed.message,
        retryable: parsed.retryable ?? false,
      },
    };
  }
}
