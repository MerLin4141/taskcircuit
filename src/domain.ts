export type WorkStatus =
  | "active"
  | "waiting_input"
  | "waiting_schedule"
  | "completed"
  | "failed"
  | "cancelled";
export type ExecutionStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_input"
  | "retry_wait"
  | "completed"
  | "failed"
  | "cancelled";
export type InteractionStatus = "open" | "resolved" | "cancelled";
export interface Execution {
  id: string;
  workItemId: string;
  sequence: number;
  status: ExecutionStatus;
  agentProfileId: string;
  agentSessionId: string | null;
  input: Record<string, unknown>;
  triggerKind: "initial" | "human_answer" | "retry" | "scheduled_resume";
  retryAttempt: number;
}
export interface AgentSession {
  id: string;
  workItemId: string;
  adapter: string;
  externalSessionId: string;
}
export interface Question {
  title: string;
  text: string;
  options: string[];
  key: string;
}
export type AgentResult =
  | { type: "needs_input"; sessionId: string; request: Question }
  | { type: "completed"; sessionId: string; output: string }
  | { type: "continue" | "stop"; sessionId: string; message: string }
  | {
      type: "later";
      sessionId: string;
      message: string;
      afterSeconds?: number;
      runAt?: string;
    }
  | {
      type: "failed";
      sessionId?: string;
      error:
        | string
        | {
            code: string;
            message: string;
            retryable?: boolean;
            causeCode?: string;
            safeToRetry?: boolean;
          };
    };
export class TaskCircuitError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
