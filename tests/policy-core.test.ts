// Guards deterministic authorization against untrusted event content and capability escalation.
import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../src/policy-core.js";
const input = {
  rootStatus: "created" as const,
  automationEnabled: true,
  eventType: "demo.color",
  definition: {
    policy: {
      effect: "authorize",
      eventTypes: ["demo.color"],
      agentProfileId: "safe-agent",
      workspaceId: "safe-workspace",
      allowedCapabilities: ["read_files"],
      requestedCapabilities: ["read_files"],
      requiresApproval: false,
    },
  },
  facts: {
    agentRegistered: true,
    profileMatches: true,
    workspaceValid: true,
    workspaceMatches: true,
    allowedByLocal: ["read_files"],
    existingWorkItemId: null,
  },
  untrustedPayload: {
    agent: "admin",
    cwd: "C:\\\\Windows",
    capabilities: ["shell", "network"],
    approval: false,
    trust: "admin",
  },
};
describe("pure policy", () => {
  it("authorizes using only trusted snapshot and records an intent", () => {
    const a = evaluatePolicy(input);
    const b = evaluatePolicy({
      ...input,
      untrustedPayload: { agent: "other", cwd: "elsewhere" },
    });
    expect(a).toEqual(b);
    expect(a.type).toBe("authorize_execution");
    expect(a.plan?.agentProfileId).toBe("safe-agent");
    expect(a.plan?.workspaceId).toBe("safe-workspace");
    expect(a.plan?.capabilities).toEqual(["read_files"]);
    expect(a.plan?.workItem).toEqual({ kind: "create_work_item" });
  });
  it.each([
    ["blocked", "root_blocked"],
    ["completed", "root_terminal"],
    ["failed", "root_terminal"],
    ["cancelled", "root_terminal"],
    ["expired", "root_terminal"],
  ] as const)("blocks %s Root", (state, reason) => {
    const r = evaluatePolicy({ ...input, rootStatus: state });
    expect(r.type).toBe("block");
    expect(r.reasonCode).toBe(reason);
  });
  it("fails closed for missing profile, invalid workspace and escalation", () => {
    expect(
      evaluatePolicy({
        ...input,
        facts: { ...input.facts, agentRegistered: false },
      }).reasonCode,
    ).toBe("agent_profile_missing");
    expect(
      evaluatePolicy({
        ...input,
        facts: { ...input.facts, workspaceValid: false },
      }).reasonCode,
    ).toBe("workspace_invalid");
    expect(
      evaluatePolicy({
        ...input,
        definition: {
          policy: {
            ...input.definition.policy,
            requestedCapabilities: ["read_files", "shell"],
          },
        },
      }).reasonCode,
    ).toBe("capability_denied");
  });
  it("does not authorize disabled definitions, approvals or non-actionable Events", () => {
    expect(evaluatePolicy({ ...input, automationEnabled: false }).type).toBe(
      "block",
    );
    expect(
      evaluatePolicy({
        ...input,
        definition: {
          policy: { ...input.definition.policy, requiresApproval: true },
        },
      }).type,
    ).toBe("wait");
    expect(evaluatePolicy({ ...input, eventType: "other.event" }).type).toBe(
      "ignore",
    );
  });
});
it("evaluates 10000 inputs deterministically", () => {
  const expected = evaluatePolicy(input);
  for (let i = 0; i < 10000; i++)
    expect(evaluatePolicy(input)).toEqual(expected);
});
