export class AgentError extends Error {
    code;
    retryable;
    outcomeUnknown;
    safeToRetry;
    constructor(code, message, retryable = false, outcomeUnknown = false, safeToRetry = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.outcomeUnknown = outcomeUnknown;
        this.safeToRetry = safeToRetry;
        this.name = this.constructor.name;
    }
}
export class AgentUnavailableError extends AgentError {
    constructor() {
        super("agent_unavailable", "Agent CLI is unavailable. Check that it is installed.");
    }
}
export function classifyStartFailure(error) {
    const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return ["EAGAIN", "EMFILE", "ENFILE"].includes(code)
        ? new AgentExecutionError("Agent process could not be started temporarily.", true, false, true)
        : new AgentUnavailableError();
}
export class AgentAuthenticationError extends AgentError {
    constructor() {
        super("auth_failed", "Agent authentication failed. Check CLI login.");
    }
}
export class AgentProtocolError extends AgentError {
    constructor() {
        super("agent_protocol", "Agent output does not match the required protocol.");
    }
}
export class AgentExecutionError extends AgentError {
    constructor(message = "Agent execution failed", retryable = false, outcomeUnknown = false, safeToRetry = false) {
        super("agent_execution", message, retryable, outcomeUnknown, safeToRetry);
    }
}
export class AgentResumeError extends AgentError {
    constructor() {
        super("agent_resume", "Agent session resume failed.");
    }
}
export class AgentEnvironmentError extends AgentError {
    constructor() {
        super("agent_environment", "Agent environment is unavailable.");
    }
}
export class AgentTimeoutError extends AgentError {
    constructor() {
        super("agent_timeout", "Agent execution timed out.", false, true);
    }
}
export function classifyAgentFailure(adapter, result, resume = false) {
    const text = result.stderr + "\n" + result.stdout;
    const label = adapter === "codex" ? "Codex" : "Claude Code";
    if (/insufficient[_ ]quota|quota (?:exceeded|exhausted)|usage limit (?:reached|exceeded)|hit (?:your )?usage limit|credits? (?:exhausted|depleted)|monthly limit/i.test(text))
        return new AgentError("quota_exceeded", `${label} usage quota appears to be exhausted.`, false);
    if (/\b429\b|too many requests|rate[_ -]limit(?:ed|ing)?|retry.after/i.test(text))
        return new AgentError("rate_limited", `${label} is rate limited.`, true);
    if (/authentication failed|not logged in|unauthorized|login required|invalid api key|expired credential|invalid_api_key/i.test(text))
        return new AgentAuthenticationError();
    if (/sandbox.{0,60}(unavailable|failed|not configured|error)|failed to initialize.{0,30}sandbox/i.test(text))
        return new AgentEnvironmentError();
    if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT)\b/i.test(text))
        return new AgentExecutionError("Agent connection temporarily failed.", true);
    return resume ? new AgentResumeError() : new AgentExecutionError();
}
export function processFailure(stderr, resume) {
    return classifyAgentFailure("codex", { exitCode: 1, stdout: "", stderr }, resume);
}
