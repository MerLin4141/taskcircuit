import type { AgentResult, AgentSession, Execution } from "./domain.js";
export interface AgentExecutionInput {
  execution: Execution;
  agentSession: AgentSession | null;
}
export interface AgentAdapter {
  execute(input: AgentExecutionInput): Promise<AgentResult>;
}
export class MockAgentAdapter implements AgentAdapter {
  async execute({
    execution,
    agentSession,
  }: AgentExecutionInput): Promise<AgentResult> {
    if (!agentSession)
      return {
        type: "needs_input",
        sessionId: `mock-session-${execution.workItemId}`,
        request: {
          title: "试跑：选一个颜色",
          text: "这是一次 TaskCircuit 试跑，选哪个都行。",
          options: ["蓝色", "绿色"],
          key: "demo-color",
        },
      };
    const answer = execution.input.answer;
    if (answer !== "蓝色" && answer !== "绿色")
      return { type: "failed", error: "回答不在可选项中" };
    return {
      type: "completed",
      sessionId: agentSession.externalSessionId,
      output: `你选了${answer}，TaskCircuit 试跑通过`,
    };
  }
}
