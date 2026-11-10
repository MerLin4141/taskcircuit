// Guards Worker registry dispatch and session/cancellation propagation without real agents.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerPluginRegistry } from "../src/plugins/builtin/agents.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { PluginNotFoundError } from "../src/plugins/errors.js";
import { workOnce } from "../src/worker.js";
import type { AgentExecutionInput } from "../src/adapter.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const installHub = (
  adapter: string,
  externalSessionId: string | null = null,
) => {
  let sent: any;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/claim"))
      return Response.json({
        execution: { id: "e1", workItemId: "w1", sequence: 2, retryAttempt: 0 },
        agentSession: externalSessionId ? { externalSessionId } : null,
        leaseToken: "fixture-token",
        agentProfile: { adapter, model: "fixture-model", config: {} },
        workItem: { metadata: { instruction: "trusted instruction" } },
        event: { source: "local", type: "demo.color", payload: { data: 1 } },
        previousInteractions: [{ request: "question", response: "answer" }],
      });
    if (url.endsWith("/result")) {
      sent = JSON.parse(String(init?.body));
      return Response.json({
        status: "accepted",
        receipt: {
          executionId: "e1",
          submissionId: sent.submissionId,
          resultDigest: sent.resultDigest,
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return () => sent;
};

describe("Worker Agent Plugin integration", () => {
  it("registers exactly the existing builtins using API v1", () => {
    const r = createWorkerPluginRegistry();
    expect(r.listAgents().map((p) => p.manifest.id)).toEqual([
      "claude",
      "codex",
      "mock",
    ]);
    for (const p of r.listAgents())
      expect(p.manifest).toMatchObject({ kind: "agent", apiVersion: 1 });
    expect(() => r.getAgent("unknown")).toThrow(PluginNotFoundError);
  });
  it("dispatches a mock profile through registry lookup", async () => {
    const result = installHub("mock");
    const r = createWorkerPluginRegistry();
    const lookup = vi.spyOn(r, "getAgent");
    const execute = vi.spyOn(r.getAgent("mock"), "execute");
    expect(
      await workOnce(
        "http://localhost",
        "worker",
        undefined,
        undefined,
        undefined,
        r,
      ),
    ).toBe(true);
    expect(lookup).toHaveBeenCalledWith("mock");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result().result.type).toBe("needs_input");
  });
  it("dispatches a newly registered Agent and forwards session, data and signal", async () => {
    const result = installHub("test-agent", "existing-session");
    const r = new PluginRegistry();
    let input: AgentExecutionInput | undefined;
    let signal: AbortSignal | undefined;
    r.register({
      manifest: {
        id: "test-agent",
        kind: "agent",
        apiVersion: 1,
        version: "test",
      },
      async execute(value, abort) {
        input = value;
        signal = abort;
        return {
          type: "completed",
          sessionId: value.externalSessionId!,
          output: "done",
        };
      },
    });
    expect(
      await workOnce(
        "http://localhost",
        "worker",
        undefined,
        undefined,
        undefined,
        r,
      ),
    ).toBe(true);
    expect(input).toMatchObject({
      externalSessionId: "existing-session",
      instruction: "trusted instruction",
      model: "fixture-model",
      previousAnswers: [{ question: "question", answer: "answer" }],
      context: { payload: { data: 1 } },
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(result().result).toMatchObject({
      type: "completed",
      sessionId: "existing-session",
    });
  });
});
