import { MockAgentAdapter, type AgentAdapter } from "./adapter.js";
import type { AgentSession, Execution, AgentResult } from "./domain.js";
import { CodexAdapter } from "./agents/codex/adapter.js";
import { ClaudeAdapter } from "./agents/claude/adapter.js";
import { AgentError } from "./agents/errors.js";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
interface Claim {
  execution: Execution;
  agentSession: AgentSession | null;
  leaseToken: string;
  agentProfile: {
    adapter: "mock" | "codex" | "claude";
    model: string | null;
    config: { isolation?: string; workspaceRoot?: string };
  };
  workItem: { metadata: { instruction?: string } };
  event: { source: string; type: string; payload: unknown } | null;
  previousInteractions: { request: unknown; response: unknown }[];
}
const log = (
  level: string,
  message: string,
  workItemId: string | null,
  executionId: string | null,
  workerId: string,
) =>
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      component: "worker",
      message,
      workItemId,
      executionId,
      workerId,
    }),
  );
export async function workOnce(
  base: string,
  workerId: string,
  adapter?: AgentAdapter,
): Promise<boolean> {
  const post = (path: string, payload: unknown) =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const claimed = await post("/api/executions/claim", { workerId });
  if (claimed.status === 204) return false;
  if (!claimed.ok) throw new Error(`领取失败: ${claimed.status}`);
  const {
    execution,
    agentSession,
    leaseToken,
    agentProfile,
    workItem,
    event,
    previousInteractions,
  } = (await claimed.json()) as Claim;
  const credentials = { workerId, leaseToken };
  let heartbeatFailed = false;
  const timer = setInterval(() => {
    void post(`/api/executions/${execution.id}/heartbeat`, credentials)
      .then((r) => {
        if (!r.ok) heartbeatFailed = true;
      })
      .catch(() => {
        heartbeatFailed = true;
      });
  }, 10000);
  try {
    log("info", "开始执行", execution.workItemId, execution.id, workerId);
    let result: AgentResult;
    try {
      const registry: Record<string, () => AgentAdapter> = {
        mock: () => new MockAgentAdapter(),
        codex: () => new CodexAdapter(),
        claude: () => new ClaudeAdapter(),
      };
      const chosen = adapter ?? registry[agentProfile.adapter]?.();
      if (!chosen) throw new Error("不支持的 Agent");
      if (
        (agentProfile.config.isolation ?? "trusted-local") !== "trusted-local"
      )
        throw new Error("隔离模式尚不支持");
      const stateRoot = resolve(
        process.env.TASKCIRCUIT_HOME ?? join(homedir(), ".taskcircuit"),
      );
      const workspaceRoot = resolve(
        agentProfile.config.workspaceRoot ??
          process.env.TASKCIRCUIT_WORKSPACE_ROOT ??
          join(tmpdir(), "taskcircuit-workspaces"),
      );
      const workingDirectory = join(workspaceRoot, execution.workItemId);
      const fromState = relative(stateRoot, workingDirectory);
      if (
        !fromState ||
        (!fromState.startsWith(
          `..${process.platform === "win32" ? "\\" : "/"}`,
        ) &&
          fromState !== ".." &&
          !isAbsolute(fromState))
      )
        throw new Error("工作目录不能位于状态目录内");
      if (agentProfile.adapter !== "mock")
        mkdirSync(workingDirectory, { recursive: true });
      result = await chosen.execute({
        workItemId: execution.workItemId,
        executionId: execution.id,
        externalSessionId: agentSession?.externalSessionId ?? null,
        workingDirectory,
        instruction: workItem.metadata.instruction ?? "",
        context: event
          ? { source: event.source, type: event.type, payload: event.payload }
          : null,
        previousAnswers: previousInteractions.map((i) => ({
          question: i.request,
          answer: i.response,
        })),
        model: agentProfile.model,
      });
    } catch (error) {
      result = {
        type: "failed",
        error:
          error instanceof AgentError
            ? { code: error.code, message: error.message }
            : { code: "agent_execution", message: "Agent 执行失败" },
      };
    }
    if (heartbeatFailed) throw new Error("续租失败");
    const submitted = await post(`/api/executions/${execution.id}/result`, {
      ...credentials,
      result,
    });
    if (!submitted.ok) throw new Error(`提交失败: ${submitted.status}`);
    log("info", "执行结果已保存", execution.workItemId, execution.id, workerId);
    return true;
  } finally {
    clearInterval(timer);
  }
}
