export class AgentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}
export class AgentUnavailableError extends AgentError {
  constructor() {
    super("agent_unavailable", "Agent CLI 不可用");
  }
}
export class AgentAuthenticationError extends AgentError {
  constructor() {
    super("agent_authentication", "Agent 身份验证失败");
  }
}
export class AgentProtocolError extends AgentError {
  constructor() {
    super("agent_protocol", "Agent 输出不符合协议");
  }
}
export class AgentExecutionError extends AgentError {
  constructor(message = "Agent 执行失败") {
    super("agent_execution", message);
  }
}
export class AgentResumeError extends AgentError {
  constructor() {
    super("agent_resume", "Agent 会话恢复失败");
  }
}
export class AgentEnvironmentError extends AgentError {
  constructor() {
    super("agent_environment", "Agent 运行环境不满足要求");
  }
}

export function processFailure(stderr: string, resume: boolean): AgentError {
  if (/authenticat|not logged in|unauthorized|login required/i.test(stderr))
    return new AgentAuthenticationError();
  if (
    /sandbox.{0,60}(unavailable|failed|not configured|error)|failed to initialize.{0,30}sandbox/i.test(
      stderr,
    )
  )
    return new AgentEnvironmentError();
  return resume ? new AgentResumeError() : new AgentExecutionError();
}
