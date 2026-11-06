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
  | { type: "failed"; error: string | { code: string; message: string } };
export class TaskCircuitError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
