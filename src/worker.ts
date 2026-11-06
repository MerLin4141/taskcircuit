import { MockAgentAdapter, type AgentAdapter } from "./adapter.js";
import type { AgentSession, Execution, AgentResult } from "./domain.js";
interface Claim {
  execution: Execution;
  agentSession: AgentSession | null;
  leaseToken: string;
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
  adapter: AgentAdapter = new MockAgentAdapter(),
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
  const { execution, agentSession, leaseToken } =
    (await claimed.json()) as Claim;
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
      result = await adapter.execute({ execution, agentSession });
    } catch {
      result = { type: "failed", error: "Agent 执行失败" };
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
