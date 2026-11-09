import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { relative, isAbsolute, sep } from "node:path";
import { resultDigest } from "./result-receipt.js";
import type { Config } from "./config.js";
type Row = Record<string, unknown>;
export type Admission = {
  status: "admitted" | "denied" | "deferred";
  reason: string;
  workspace?: string;
  deadlineAt?: string;
};
export function runCount(db: DatabaseSync, rootId: string): number {
  return Number(
    db
      .prepare(
        `SELECT COUNT(*) n FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE w.root_id=? AND e.started_at IS NOT NULL AND NOT (e.status='failed' AND json_valid(e.error) AND COALESCE(json_extract(e.error,'$.safeToRetry'),0)=1)`,
      )
      .get(rootId)?.n,
  );
}
export function inspectAdmission(
  db: DatabaseSync,
  executionId: string,
  config: Config,
  time: string,
  allowWaiting = false,
  excludeCurrent = false,
): Admission {
  const e = db
    .prepare(
      `SELECT e.id,e.work_item_id,e.agent_profile_id,r.id root_id,r.mode,r.status root_status,r.max_runs,r.deadline_at,w.status work_status,w.metadata FROM executions e JOIN work_items w ON w.id=e.work_item_id JOIN automation_roots r ON r.id=w.root_id WHERE e.id=?`,
    )
    .get(executionId) as Row | undefined;
  if (!e) return { status: "denied", reason: "execution_missing" };
  if (
    !["active", "waiting"].includes(String(e.root_status)) ||
    !(
      e.work_status === "active" ||
      (allowWaiting &&
        ["waiting_schedule", "waiting_input"].includes(String(e.work_status)))
    )
  )
    return {
      status: "denied",
      reason: e.root_status === "blocked" ? "root_blocked" : "root_terminal",
    };
  if (e.mode === "automation") {
    if (typeof e.deadline_at !== "string" || !Number.isSafeInteger(e.max_runs))
      return { status: "denied", reason: "loop_config_invalid" };
    if (time >= e.deadline_at)
      return { status: "denied", reason: "loop_deadline_reached" };
  }
  const busy = db
    .prepare(
      `SELECT 1 FROM executions x JOIN work_items w ON w.id=x.work_item_id WHERE w.root_id=? AND x.id<>? AND (x.status IN ('running','claimed') OR (x.status='failed' AND json_valid(x.error) AND json_extract(x.error,'$.code')='execution_outcome_unknown')) LIMIT 1`,
    )
    .get(String(e.root_id), executionId);
  if (busy) return { status: "deferred", reason: "root_busy" };
  if (e.mode !== "automation") return { status: "admitted", reason: "legacy" };
  if (
    runCount(db, String(e.root_id)) - (excludeCurrent ? 1 : 0) >=
    Number(e.max_runs)
  )
    return { status: "denied", reason: "loop_max_runs_reached" };
  const d = db
    .prepare(
      `SELECT d.*,v.config_snapshot_json FROM decision_materializations m JOIN decisions d ON d.id=m.decision_id JOIN automation_definition_versions v ON v.definition_id=d.definition_id AND v.version=d.definition_version WHERE m.work_item_id=? AND d.root_id=? AND d.decision_type='authorize_execution' ORDER BY d.sequence LIMIT 1`,
    )
    .get(String(e.work_item_id), String(e.root_id)) as Row | undefined;
  if (!d) return { status: "denied", reason: "authorization_missing" };
  try {
    const plan = JSON.parse(String(d.plan_json));
    const snapshot = JSON.parse(String(d.config_snapshot_json));
    const profile = config.agents[String(d.agent_profile_id)];
    const ws = config.policyWorkspaces?.[String(d.workspace_id)];
    if (
      resultDigest(plan) !== d.plan_digest ||
      !profile ||
      !ws ||
      resultDigest(profile) !==
        resultDigest(snapshot.policy.agentProfileSnapshot) ||
      resultDigest({ profile, workspace: ws }) !== d.trusted_config_hash
    )
      return { status: "denied", reason: "authorization_changed" };
    const expected = `automation:${resultDigest({ id: d.agent_profile_id, profile, workspacePath: plan.workspacePath, capabilities: plan.capabilities })}`;
    if (e.agent_profile_id !== expected)
      return { status: "denied", reason: "authorization_changed" };
    const base = realpathSync(ws.allowedRoot),
      workspace = realpathSync(ws.path),
      rel = relative(base, workspace);
    if (
      !isAbsolute(base) ||
      !isAbsolute(workspace) ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      !statSync(workspace).isDirectory() ||
      workspace !== realpathSync(String(plan.workspacePath))
    )
      return { status: "denied", reason: "workspace_invalid" };
    return {
      status: "admitted",
      reason: "authorized",
      workspace,
      deadlineAt: String(e.deadline_at),
    };
  } catch {
    return { status: "denied", reason: "authorization_changed" };
  }
}
export function terminateForLimit(
  db: DatabaseSync,
  rootId: string,
  reason: string,
  time: string,
): void {
  const root = db
    .prepare(
      "SELECT status FROM automation_roots WHERE id=? AND mode='automation'",
    )
    .get(rootId);
  if (!root || !["created", "active", "waiting"].includes(String(root.status)))
    return;
  const busy = db
    .prepare(
      `SELECT 1 FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE w.root_id=? AND e.status IN ('running','claimed')`,
    )
    .get(rootId);
  if (busy) return;
  db.prepare(
    "UPDATE automation_roots SET status=?,terminal_reason=?,terminal_at=?,updated_at=?,version=version+1 WHERE id=?",
  ).run(
    reason === "loop_deadline_reached" ? "expired" : "budget_exhausted",
    reason,
    time,
    time,
    rootId,
  );
  db.prepare(
    "UPDATE executions SET status='cancelled',finished_at=? WHERE status='queued' AND work_item_id IN (SELECT id FROM work_items WHERE root_id=?)",
  ).run(time, rootId);
  db.prepare(
    "UPDATE schedules SET status='cancelled',updated_at=? WHERE status IN ('active','paused') AND owner_kind='work_item' AND owner_id IN (SELECT id FROM work_items WHERE root_id=?)",
  ).run(time, rootId);
  db.prepare(
    "UPDATE work_items SET status='failed',updated_at=? WHERE root_id=? AND status IN ('active','waiting_schedule','waiting_input')",
  ).run(time, rootId);
}
export function materializeContinuation(
  db: DatabaseSync,
  parentId: string,
  config: Config,
  time: string,
  onStage?: (stage: string) => void,
): Admission {
  const parent = db
    .prepare(
      `SELECT e.*,w.root_id,w.status work_status,r.mode,r.status root_status,r.max_runs,r.deadline_at FROM executions e JOIN work_items w ON w.id=e.work_item_id JOIN automation_roots r ON r.id=w.root_id WHERE e.id=?`,
    )
    .get(parentId) as Row | undefined;
  if (
    !parent ||
    parent.mode !== "automation" ||
    parent.status !== "completed" ||
    parent.work_status !== "waiting_schedule"
  )
    return { status: "denied", reason: "invalid_continuation" };
  try {
    const out = JSON.parse(String(parent.output));
    if (out.feedback !== "continue")
      return { status: "denied", reason: "invalid_continuation" };
  } catch {
    return { status: "denied", reason: "invalid_continuation" };
  }
  if (
    db
      .prepare(
        "SELECT id FROM executions WHERE trigger_kind='continue' AND parent_execution_id=?",
      )
      .get(parentId)
  )
    return { status: "admitted", reason: "already_created" };
  const root = String(parent.root_id);
  const check = inspectAdmission(db, parentId, config, time, true);
  if (check.status !== "admitted") {
    if (
      check.status === "denied" &&
      ["loop_deadline_reached", "loop_max_runs_reached"].includes(check.reason)
    )
      terminateForLimit(db, root, check.reason, time);
    return check;
  }
  if (
    db
      .prepare(
        `SELECT 1 FROM executions x JOIN work_items w ON w.id=x.work_item_id WHERE w.root_id=? AND x.status='queued' LIMIT 1`,
      )
      .get(root)
  )
    return { status: "deferred", reason: "root_busy" };
  const last = Number(
    db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) n FROM executions WHERE work_item_id=?",
      )
      .get(String(parent.work_item_id))?.n,
  );
  const id = randomUUID();
  db.prepare(
    `INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,agent_session_id,not_before,input,created_at,trigger_kind,parent_execution_id,retry_attempt) VALUES(?,?,?,'queued',?,?,?,?,?,'continue',?,0)`,
  ).run(
    id,
    String(parent.work_item_id),
    last + 1,
    String(parent.agent_profile_id),
    parent.agent_session_id as string | null,
    time,
    "{}",
    time,
    parentId,
  );
  onStage?.("successor-inserted");
  db.prepare(
    "UPDATE work_items SET status='active',updated_at=? WHERE id=?",
  ).run(time, String(parent.work_item_id));
  return { status: "admitted", reason: "continuation_created" };
}
export function recoverContinuations(
  db: DatabaseSync,
  config: Config,
  time: string,
): void {
  const rows = db
    .prepare(
      `SELECT e.id FROM executions e JOIN work_items w ON w.id=e.work_item_id JOIN automation_roots r ON r.id=w.root_id WHERE r.mode='automation' AND w.status='waiting_schedule' AND e.status='completed' AND json_valid(e.output) AND json_extract(e.output,'$.feedback')='continue' AND NOT EXISTS(SELECT 1 FROM executions x WHERE x.parent_execution_id=e.id AND x.trigger_kind='continue') ORDER BY e.finished_at,e.id LIMIT 100`,
    )
    .all();
  for (const row of rows)
    materializeContinuation(db, String(row.id), config, time);
}

export const claimCandidateSql = `SELECT e.* FROM executions e JOIN work_items w ON w.id=e.work_item_id JOIN automation_roots r ON r.id=w.root_id WHERE e.status='queued' AND e.not_before<=? AND w.status='active' AND r.status IN ('active','waiting') AND NOT EXISTS (SELECT 1 FROM executions other JOIN work_items ow ON ow.id=other.work_item_id WHERE ow.root_id=w.root_id AND (other.status IN ('claimed','running') OR (other.status='failed' AND json_valid(other.error) AND json_extract(other.error,'$.code')='execution_outcome_unknown'))) ORDER BY e.created_at,e.sequence LIMIT 1`;

export function expireQueuedAutomations(db: DatabaseSync, time: string): void {
  const rows = db
    .prepare(
      `SELECT r.id FROM automation_roots r WHERE r.mode='automation' AND r.status IN ('created','active','waiting') AND r.deadline_at<=? AND (EXISTS(SELECT 1 FROM work_items w JOIN executions e ON e.work_item_id=w.id WHERE w.root_id=r.id AND e.status='queued') OR EXISTS(SELECT 1 FROM work_items w WHERE w.root_id=r.id AND w.status='waiting_input' AND EXISTS(SELECT 1 FROM interactions i WHERE i.work_item_id=w.id AND i.status='resolved') AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.work_item_id=w.id AND i.status='open'))) ORDER BY r.id`,
    )
    .all(time);
  for (const r of rows)
    terminateForLimit(db, String(r.id), "loop_deadline_reached", time);
}
