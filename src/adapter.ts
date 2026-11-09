import type { AgentResult } from "./domain.js";
export interface AgentExecutionInput {
  workItemId: string;
  executionId: string;
  workingDirectory: string;
  instruction: string;
  context: unknown;
  previousAnswers: { question: unknown; answer: unknown }[];
  externalSessionId: string | null;
  model?: string | null;
  retryAttempt?: number;
}
export interface AgentAdapter {
  execute(
    input: AgentExecutionInput,
    signal?: AbortSignal,
  ): Promise<AgentResult>;
}
export class MockAgentAdapter implements AgentAdapter {
  async execute(
    input: AgentExecutionInput,
    signal?: AbortSignal,
  ): Promise<AgentResult> {
    const context = input.context as { type?: string } | null;
    if (context?.type === "demo.lease") {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("执行已中止"));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, 15000);
        const abort = () => {
          clearTimeout(timer);
          reject(new Error("执行已中止"));
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
      return {
        type: "completed",
        sessionId:
          input.externalSessionId ?? `mock-session-${input.workItemId}`,
        output: "TaskCircuit Lease 试跑通过",
      };
    }
    if (context?.type === "demo.later")
      return input.externalSessionId
        ? {
            type: "completed",
            sessionId: input.externalSessionId,
            output: "TaskCircuit Later 试跑通过",
          }
        : {
            type: "later",
            sessionId: `mock-session-${input.workItemId}`,
            message: "稍后继续",
            afterSeconds: 2,
          };
    if (
      context?.type === "demo.retry" ||
      context?.type === "demo.retry.exhaust"
    ) {
      if (context.type === "demo.retry.exhaust" || !input.retryAttempt)
        return {
          type: "failed",
          error: {
            code: "agent_execution",
            message: "模拟临时故障",
            retryable: true,
            safeToRetry: true,
          },
        };
      return {
        type: "completed",
        sessionId:
          input.externalSessionId ?? `mock-session-${input.workItemId}`,
        output: "TaskCircuit Retry 试跑通过",
      };
    }
    if (context?.type === "demo.cron")
      return {
        type: "completed",
        sessionId: `mock-session-${input.workItemId}`,
        output: "TaskCircuit Cron 试跑通过",
      };
    if (!input.externalSessionId)
      return {
        type: "needs_input",
        sessionId: `mock-session-${input.workItemId}`,
        request: {
          title: "试跑：选一个颜色",
          text: "这是一次 TaskCircuit 试跑，选哪个都行。",
          options: ["蓝色", "绿色"],
          key: "demo-color",
        },
      };
    const answer = input.previousAnswers.at(-1)?.answer;
    if (answer !== "蓝色" && answer !== "绿色")
      return { type: "failed", error: "回答不在可选项中" };
    return {
      type: "completed",
      sessionId: input.externalSessionId,
      output: `你选了${answer}，TaskCircuit 试跑通过`,
    };
  }
}
