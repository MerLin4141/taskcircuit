export const POLICY_ENGINE_VERSION = "taskcircuit-policy-v1";
export const CAPABILITIES = [
  "read_files",
  "write_files",
  "shell",
  "network",
  "external_action",
] as const;
type Capability = (typeof CAPABILITIES)[number];
type JsonObject = Record<string, unknown>;
export type PolicyInput = {
  rootStatus: string;
  automationEnabled: boolean;
  eventType: string;
  definition: unknown;
  facts: {
    sourceInstance?: string | null;
    sourceTrustContext?: string | null;
    agentRegistered: boolean;
    profileMatches: boolean;
    workspaceValid: boolean;
    workspaceMatches: boolean;
    allowedByLocal: string[];
    existingWorkItemId: string | null;
    workItemAmbiguous?: boolean;
  };
  untrustedPayload?: unknown;
};
export type DecisionType =
  "authorize_execution" | "ignore" | "block" | "wait" | "reject";
export type DecisionProposal = {
  type: DecisionType;
  reasonCode: string;
  plan: null | {
    agentProfileId: string;
    workspaceId: string;
    capabilities: Capability[];
    workItem: { kind: "existing"; id: string } | { kind: "create_work_item" };
    requiresApproval: false;
  };
};
const obj = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const result = (type: DecisionType, reasonCode: string): DecisionProposal => ({
  type,
  reasonCode,
  plan: null,
});
export function evaluatePolicy(input: PolicyInput): DecisionProposal {
  if (
    [
      "completed",
      "failed",
      "cancelled",
      "expired",
      "budget_exhausted",
    ].includes(input.rootStatus)
  )
    return result("block", "root_terminal");
  if (input.rootStatus === "blocked") return result("block", "root_blocked");
  if (!["created", "active", "waiting"].includes(input.rootStatus))
    return result("reject", "root_invalid");
  if (!input.automationEnabled) return result("block", "automation_disabled");
  if (!obj(input.definition) || !obj(input.definition.policy))
    return result("block", "policy_missing");
  const p = input.definition.policy;
  if (p.sourceInstance !== undefined || p.sourceTrustContext !== undefined) {
    if (
      typeof p.sourceInstance !== "string" ||
      typeof p.sourceTrustContext !== "string" ||
      p.sourceInstance !== input.facts.sourceInstance ||
      p.sourceTrustContext !== input.facts.sourceTrustContext
    )
      return result("block", "event_source_mismatch");
  }
  if (!["authorize", "ignore", "wait", "block"].includes(String(p.effect)))
    return result("block", "policy_invalid");
  if (!strings(p.eventTypes)) return result("block", "policy_invalid");
  if (!p.eventTypes.includes(input.eventType) || p.effect === "ignore")
    return result("ignore", "event_not_actionable");
  if (p.effect === "block") return result("block", "policy_denied");
  if (p.effect === "wait") return result("wait", "policy_wait");
  if (p.requiresApproval === true) return result("wait", "approval_required");
  if (p.requiresApproval !== false) return result("block", "policy_invalid");
  if (
    typeof p.agentProfileId !== "string" ||
    !p.agentProfileId ||
    !input.facts.agentRegistered
  )
    return result("block", "agent_profile_missing");
  if (!input.facts.profileMatches)
    return result("block", "agent_profile_changed");
  if (
    typeof p.workspaceId !== "string" ||
    !p.workspaceId ||
    !input.facts.workspaceValid
  )
    return result("block", "workspace_invalid");
  if (!input.facts.workspaceMatches)
    return result("block", "workspace_changed");
  if (
    !strings(p.allowedCapabilities) ||
    !strings(p.requestedCapabilities) ||
    p.allowedCapabilities.some(
      (x) => !CAPABILITIES.includes(x as Capability),
    ) ||
    p.requestedCapabilities.some((x) => !CAPABILITIES.includes(x as Capability))
  )
    return result("block", "policy_invalid");
  const caps = [...new Set(p.requestedCapabilities)].sort() as Capability[];
  const allowed = p.allowedCapabilities as string[];
  if (
    caps.some(
      (c) =>
        c === "external_action" ||
        !allowed.includes(c) ||
        !input.facts.allowedByLocal.includes(c),
    )
  )
    return result("block", "capability_denied");
  if (input.facts.workItemAmbiguous)
    return result("block", "work_item_ambiguous");
  return {
    type: "authorize_execution",
    reasonCode: "policy_authorized",
    plan: {
      agentProfileId: p.agentProfileId,
      workspaceId: p.workspaceId,
      capabilities: caps,
      workItem: input.facts.existingWorkItemId
        ? { kind: "existing", id: input.facts.existingWorkItemId }
        : { kind: "create_work_item" },
      requiresApproval: false,
    },
  };
}
