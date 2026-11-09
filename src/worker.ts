import { MockAgentAdapter, type AgentAdapter } from "./adapter.js";
import type { AgentSession, Execution, AgentResult } from "./domain.js";
import { CodexAdapter } from "./agents/codex/adapter.js";
import { ClaudeAdapter } from "./agents/claude/adapter.js";
import { AgentError } from "./agents/errors.js";
import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { resultDigest } from "./result-receipt.js";
interface Claim {
  automationWorkspace?: string;
  automationRemainingMs?: number;
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
  shutdown?: AbortSignal,
  timing = { heartbeatMs: 10000, safetyMs: 26000, requestTimeoutMs: 3000 },
): Promise<boolean> {
  const post = (path: string, payload: unknown) =>
    fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timing.requestTimeoutMs),
    });
  if (shutdown?.aborted) return false;
  if (
    timing.heartbeatMs <= 0 ||
    timing.requestTimeoutMs <= 0 ||
    timing.safetyMs <= 0 ||
    timing.safetyMs > 26000
  )
    throw new Error("Worker lease timing is invalid");
  const claimStarted = performance.now();
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
    automationWorkspace,
    automationRemainingMs,
  } = (await claimed.json()) as Claim;
  const credentials = { workerId, leaseToken };
  const controller = new AbortController();
  let ownershipLost = false;
  let heartbeatState:
    | "healthy"
    | "temporarily_unreachable"
    | "ownership_lost"
    | "lease_uncertain"
    | "stopping" = "healthy";
  const setHeartbeatState = (next: typeof heartbeatState) => {
    if (heartbeatState !== next) {
      heartbeatState = next;
      log(
        "info",
        `心跳状态: ${next}`,
        execution.workItemId,
        execution.id,
        workerId,
      );
    }
  };
  let deadline = claimStarted + timing.safetyMs;
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  const stopForSafety = (
    reason: "ownership_lost" | "lease_uncertain" = "lease_uncertain",
  ) => {
    ownershipLost = true;
    setHeartbeatState(reason);
    controller.abort("lease");
  };
  const armSafety = () => {
    clearTimeout(safetyTimer);
    safetyTimer = setTimeout(
      () => stopForSafety(),
      Math.max(0, deadline - performance.now()),
    );
  };
  const onShutdown = () => {
    setHeartbeatState("stopping");
    controller.abort("shutdown");
  };
  shutdown?.addEventListener("abort", onShutdown, { once: true });
  if (shutdown?.aborted) onShutdown();
  armSafety();
  const timer = setInterval(() => {
    if (inFlight || controller.signal.aborted) return;
    inFlight = true;
    const started = performance.now();
    void fetch(new URL(`/api/executions/${execution.id}/heartbeat`, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
      signal: AbortSignal.timeout(timing.requestTimeoutMs),
    })
      .then((r) => {
        if (r.status === 409) stopForSafety("ownership_lost");
        else if (
          r.ok &&
          !controller.signal.aborted &&
          performance.now() < deadline
        ) {
          deadline = started + timing.safetyMs;
          setHeartbeatState("healthy");
          armSafety();
        } else if (!r.ok && !controller.signal.aborted) {
          setHeartbeatState("temporarily_unreachable");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setHeartbeatState("temporarily_unreachable");
      })
      .finally(() => {
        inFlight = false;
      });
  }, timing.heartbeatMs);
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
      const workingDirectory =
        automationWorkspace ?? join(workspaceRoot, execution.workItemId);
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
      controller.signal.throwIfAborted();
      if (automationWorkspace) {
        const preflightStarted = performance.now();
        const preflightWallStarted = Date.now();
        const start = await post(
          `/api/executions/${execution.id}/authorize-start`,
          credentials,
        );
        if (!start.ok) throw new Error("无法确认启动许可");
        const authorization = (await start.json()) as {
          status: string;
          remainingMs?: number;
        };
        if (authorization.status !== "admitted") return true;
        if (
          !Number.isFinite(authorization.remainingMs) ||
          performance.now() - preflightStarted >=
            Number(authorization.remainingMs) ||
          Date.now() - preflightWallStarted >=
            Number(authorization.remainingMs) ||
          !Number.isFinite(automationRemainingMs) ||
          performance.now() - claimStarted >= Number(automationRemainingMs)
        ) {
          await post(`/api/executions/${execution.id}/authorize-start`, {
            ...credentials,
            abandon: true,
          });
          return true;
        }
      }
      controller.signal.throwIfAborted();
      result = await chosen.execute(
        {
          workItemId: execution.workItemId,
          executionId: execution.id,
          ...(agentProfile.adapter === "mock" && event?.type === "demo.loop"
            ? { executionSequence: execution.sequence }
            : {}),
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
          retryAttempt: execution.retryAttempt,
        },
        controller.signal,
      );
    } catch (error) {
      const uncertain =
        controller.signal.aborted ||
        (error instanceof AgentError &&
          (error.code === "agent_timeout" || error.outcomeUnknown));
      result = {
        type: "failed",
        error: uncertain
          ? {
              code: "execution_outcome_unknown",
              message:
                "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
              retryable: false,
              ...(error instanceof AgentError ? { causeCode: error.code } : {}),
            }
          : error instanceof AgentError
            ? {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                safeToRetry: error.safeToRetry,
              }
            : {
                code: "execution_outcome_unknown",
                message:
                  "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
                retryable: false,
              },
      };
    }
    if (performance.now() >= deadline) stopForSafety();
    if (ownershipLost) throw new Error("续租失效，执行结果需要核实");
    if (controller.signal.aborted) {
      result = {
        type: "failed",
        error: {
          code: "execution_outcome_unknown",
          message:
            "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
          retryable: false,
        },
      };
    }
    const submissionId = randomUUID();
    const digest = resultDigest(result);
    const payload = {
      ...credentials,
      submissionId,
      resultDigest: digest,
      result,
    };
    const matches = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      const r = value as Record<string, unknown>;
      return (
        r.executionId === execution.id &&
        r.submissionId === submissionId &&
        r.resultDigest === digest
      );
    };
    let confirmed = false;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
      let rejected = false;
      try {
        const submitted = await post(
          `/api/executions/${execution.id}/result`,
          payload,
        );
        if (submitted.ok) {
          const reply: unknown = await submitted.json();
          if (
            reply &&
            typeof reply === "object" &&
            ["accepted", "already_committed"].includes(
              String((reply as Record<string, unknown>).status),
            ) &&
            matches((reply as Record<string, unknown>).receipt)
          ) {
            confirmed = true;
            break;
          }
        } else if (submitted.status === 409) rejected = true;
        else if (submitted.status < 500)
          throw new Error(`结果提交被拒绝: ${submitted.status}`);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("结果提交被拒绝:")
        )
          throw error;
      }
      try {
        const query = new URL(
          `/api/executions/${execution.id}/result-submissions/${submissionId}`,
          base,
        );
        query.searchParams.set("digest", digest);
        const response = await fetch(query, {
          signal: AbortSignal.timeout(timing.requestTimeoutMs),
        });
        if (response.status === 409) throw new Error("结果回执冲突");
        if (response.ok) {
          const reply: unknown = await response.json();
          if (reply && typeof reply === "object") {
            const record = reply as Record<string, unknown>;
            if (record.status === "committed" && matches(record.receipt)) {
              confirmed = true;
              break;
            }
            if (
              record.status === "not_found" &&
              (rejected || ownershipLost || performance.now() >= deadline)
            )
              throw new Error("租约失效，结果尚未确认");
          }
        }
      } catch (error) {
        if (
          error instanceof Error &&
          ["结果回执冲突", "租约失效，结果尚未确认"].includes(error.message)
        )
          throw error;
      }
      if (rejected || ownershipLost || performance.now() >= deadline) {
        // The next iterations can only query; never resubmit after ownership is lost.
        for (let queryAttempt = attempt + 1; queryAttempt < 3; queryAttempt++) {
          try {
            const query = new URL(
              `/api/executions/${execution.id}/result-submissions/${submissionId}`,
              base,
            );
            query.searchParams.set("digest", digest);
            const response = await fetch(query, {
              signal: AbortSignal.timeout(timing.requestTimeoutMs),
            });
            if (response.status === 409) throw new Error("结果回执冲突");
            if (response.ok) {
              const record = (await response.json()) as Record<string, unknown>;
              if (record.status === "committed" && matches(record.receipt)) {
                confirmed = true;
                break;
              }
              if (record.status === "not_found")
                throw new Error("租约失效，结果尚未确认");
            }
          } catch (error) {
            if (
              error instanceof Error &&
              ["结果回执冲突", "租约失效，结果尚未确认"].includes(error.message)
            )
              throw error;
          }
        }
        break;
      }
    }
    if (!confirmed) throw new Error("执行结果无法确认，请核实后处理");
    log("info", "执行结果已保存", execution.workItemId, execution.id, workerId);
    return true;
  } finally {
    clearInterval(timer);
    clearTimeout(safetyTimer);
    shutdown?.removeEventListener("abort", onShutdown);
  }
}
