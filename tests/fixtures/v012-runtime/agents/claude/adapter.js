import { AgentError, AgentProtocolError, classifyAgentFailure, } from "../errors.js";
import { agentEnvironment } from "../environment.js";
import { parseResponse, prompt } from "../protocol.js";
import { ProcessRunner } from "../process.js";
import { resolveCli } from "../capability.js";
export class ClaudeAdapter {
    runner;
    command;
    constructor(runner = new ProcessRunner(), command) {
        this.runner = runner;
        this.command = command;
    }
    async execute(input, signal) {
        const cmd = this.command ?? resolveCli("claude");
        const previous = input.externalSessionId;
        const args = ["--print", "--output-format", "json"];
        if (previous)
            args.push("--resume", previous);
        if (input.model)
            args.push("--model", input.model);
        const result = await this.runner.run({
            executable: cmd.executable,
            args: [...cmd.prefix, ...args],
            cwd: input.workingDirectory,
            env: agentEnvironment(process.env, "claude"),
            stdin: prompt(input),
            timeoutMs: 300000,
            signal,
        });
        if (result.exitCode !== 0) {
            const failure = classifyAgentFailure("claude", result, !!previous);
            throw new AgentError(failure.code, failure.message, failure.retryable, true);
        }
        let data;
        try {
            data = JSON.parse(result.stdout);
        }
        catch {
            throw new AgentError("agent_protocol", new AgentProtocolError().message, false, true);
        }
        if (!data || typeof data !== "object")
            throw new AgentError("agent_protocol", new AgentProtocolError().message, false, true);
        const value = data;
        if (value.is_error === true) {
            const failure = classifyAgentFailure("claude", result, !!previous);
            throw new AgentError(failure.code, failure.message, failure.retryable, true);
        }
        if (typeof value.session_id !== "string" ||
            !value.session_id.trim() ||
            typeof value.result !== "string" ||
            (previous && value.session_id !== previous))
            throw new AgentError("agent_protocol", new AgentProtocolError().message, false, true);
        let parsed;
        try {
            parsed = parseResponse(value.result);
        }
        catch {
            throw new AgentError("agent_protocol", new AgentProtocolError().message, false, true);
        }
        if (parsed.kind === "later")
            return {
                type: "later",
                sessionId: value.session_id,
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
            sessionId: value.session_id,
            error: {
                code: "execution_outcome_unknown",
                message: "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
                retryable: false,
                causeCode: "agent_reported_failure",
            },
        };
    }
}
