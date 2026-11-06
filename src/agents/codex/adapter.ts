import type { AgentAdapter, AgentExecutionInput } from "../../adapter.js";
import type { AgentResult } from "../../domain.js";
import { AgentProtocolError, processFailure } from "../errors.js";
import { agentEnvironment } from "../environment.js";
import { parseResponse, prompt } from "../protocol.js";
import { ProcessRunner, type Runner } from "../process.js";
import { resolveCli, type Executable } from "../capability.js";
export class CodexAdapter implements AgentAdapter {
  constructor(
    private runner: Runner = new ProcessRunner(),
    private command?: Executable,
  ) {}
  async execute(input: AgentExecutionInput): Promise<AgentResult> {
    const cmd = this.command ?? resolveCli("codex");
    const previous = input.externalSessionId;
    const args = previous
      ? ["exec", "resume", "--json", "--skip-git-repo-check", previous, "-"]
      : ["exec", "--json", "--skip-git-repo-check", "-"];
    if (input.model) {
      const at = previous ? 2 : 1;
      args.splice(at, 0, "--model", input.model);
    }
    const result = await this.runner.run({
      executable: cmd.executable,
      args: [...cmd.prefix, ...args],
      cwd: input.workingDirectory,
      env: agentEnvironment(process.env, "codex"),
      stdin: prompt(input),
      timeoutMs: 300000,
    });
    if (result.exitCode !== 0) throw processFailure(result.stderr, !!previous);
    let session: string | undefined;
    let text: string | undefined;
    try {
      for (const line of result.stdout.trim().split("\n")) {
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== "object") continue;
        const e = event as Record<string, unknown>;
        if (e.type === "thread.started" && typeof e.thread_id === "string")
          session = e.thread_id;
        if (
          e.type === "item.completed" &&
          e.item &&
          typeof e.item === "object"
        ) {
          const item = e.item as Record<string, unknown>;
          if (item.type === "agent_message" && typeof item.text === "string")
            text = item.text;
        }
      }
    } catch {
      throw new AgentProtocolError();
    }
    if (!session || !text || (previous && session !== previous))
      throw new AgentProtocolError();
    const parsed = parseResponse(text);
    if (parsed.kind === "later")
      return {
        type: "later",
        sessionId: session as string,
        message: parsed.message,
        ...(parsed.afterSeconds !== undefined
          ? { afterSeconds: parsed.afterSeconds }
          : { runAt: parsed.runAt }),
      };
    if (parsed.kind === "ask")
      return {
        type: "needs_input",
        sessionId: session,
        request: parsed.interaction,
      };
    if (parsed.kind === "complete")
      return { type: "completed", sessionId: session, output: parsed.message };
    return {
      type: "failed",
      sessionId: session as string,
      error: {
        code: "agent_reported_failure",
        message: parsed.message,
        retryable: parsed.retryable ?? false,
      },
    };
  }
}
