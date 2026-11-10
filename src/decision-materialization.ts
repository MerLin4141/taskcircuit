import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { resultDigest } from "./result-receipt.js";
import { validPolicy } from "./scheduling.js";
import { TaskCircuitError } from "./domain.js";
import type { Config } from "./config.js";
const fail = (code: string): never => {
  throw new TaskCircuitError(code, "自动化决策无法物化", 409);
};
export function migrateMaterialization(
  db: DatabaseSync,
  onStage?: (stage: string) => void,
): void {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
    throw Error("foreign keys required");
  if (
    db.prepare("SELECT generation FROM taskcircuit_generation").get()
      ?.generation !== 2
  )
    throw Error("generation 2 required");
  const version = () =>
    Number(db.prepare("SELECT MAX(version) v FROM schema_migrations").get()?.v);
  if (version() > 10) fail("database_schema_too_new");
  if (version() === 9 || version() === 10) {
    if (
      !db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='decision_materializations'",
        )
        .get()
    )
      throw Error("schema 9 incomplete");
    return;
  }
  if (version() !== 8) throw Error("schema 8 required");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version() === 9 || version() === 10) {
      db.exec("COMMIT");
      return;
    }
    if (version() !== 8) throw Error("schema 8 required");
    db.exec(`CREATE TABLE decision_materializations(decision_id TEXT PRIMARY KEY REFERENCES decisions(id),work_item_id TEXT NOT NULL REFERENCES work_items(id),execution_id TEXT REFERENCES executions(id),created_at TEXT NOT NULL);
 CREATE TRIGGER materialization_no_update BEFORE UPDATE ON decision_materializations BEGIN SELECT RAISE(ABORT,'materialization_immutable'); END;
 CREATE TRIGGER materialization_no_delete BEFORE DELETE ON decision_materializations BEGIN SELECT RAISE(ABORT,'materialization_immutable'); END;`);
    const view = String(
      db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='view' AND name='root_status_projection'",
        )
        .get()?.sql ?? "",
    );
    if (!view.includes("ELSE 'completed' END AS projected_status"))
      throw Error("unexpected root projection");
    const updated = view.replace(
      "ELSE 'completed' END AS projected_status",
      `WHEN EXISTS(SELECT 1 FROM decisions d WHERE d.root_id=r.id AND d.decision_type='authorize_execution' AND NOT EXISTS(SELECT 1 FROM decision_materializations m WHERE m.decision_id=d.id)) THEN 'waiting' ELSE 'completed' END AS projected_status`,
    );
    db.exec("DROP VIEW root_status_projection");
    db.exec(updated);
    onStage?.("created");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("foreign key check failed");
    onStage?.("before-schema-update");
    db.prepare("INSERT INTO schema_migrations VALUES(9,?)").run(
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function materializeDecision(
  db: DatabaseSync,
  id: string,
  config: Config,
  now: () => number,
): { workItemId: string; executionId: string | null } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare(
        "SELECT work_item_id,execution_id FROM decision_materializations WHERE decision_id=?",
      )
      .get(id);
    if (existing) {
      db.exec("COMMIT");
      return {
        workItemId: String(existing.work_item_id),
        executionId:
          existing.execution_id === null ? null : String(existing.execution_id),
      };
    }
    const row = db
      .prepare(
        `SELECT d.*,r.status root_status,r.mode, v.config_snapshot_json FROM decisions d JOIN automation_roots r ON r.id=d.root_id JOIN automation_definition_versions v ON v.definition_id=d.definition_id AND v.version=d.definition_version WHERE d.id=?`,
      )
      .get(id);
    if (
      !row ||
      row.decision_type !== "authorize_execution" ||
      row.mode !== "automation" ||
      !["created", "active", "waiting"].includes(String(row.root_status))
    )
      fail("materialization_not_allowed");
    const plan = JSON.parse(String(row!.plan_json));
    if (resultDigest(plan) !== row!.plan_digest)
      fail("materialization_plan_invalid");
    const snapshot = JSON.parse(String(row!.config_snapshot_json));
    const profile = snapshot?.policy?.agentProfileSnapshot;
    if (
      snapshot.retryPolicy !== undefined &&
      !validPolicy(snapshot.retryPolicy)
    )
      fail("materialization_retry_policy_invalid");
    if (
      snapshot.instruction !== undefined &&
      typeof snapshot.instruction !== "string"
    )
      fail("materialization_instruction_invalid");
    if (
      snapshot.notify !== undefined &&
      (!Array.isArray(snapshot.notify) ||
        snapshot.notify.some((id: unknown) => typeof id !== "string"))
    )
      fail("materialization_notify_invalid");
    if (
      snapshot.notifyOnCompleted !== undefined &&
      typeof snapshot.notifyOnCompleted !== "boolean"
    )
      fail("materialization_notify_invalid");
    if (
      !profile ||
      !config.agents[String(row!.agent_profile_id)] ||
      resultDigest(profile) !==
        resultDigest(config.agents[String(row!.agent_profile_id)])
    )
      fail("materialization_profile_changed");
    const ws = config.policyWorkspaces?.[String(row!.workspace_id)];
    if (!ws) return fail("materialization_config_changed");
    if (
      resultDigest({
        profile: config.agents[String(row!.agent_profile_id)],
        workspace: ws,
      }) !== row!.trusted_config_hash
    )
      fail("materialization_config_changed");
    try {
      const base = realpathSync(ws.allowedRoot),
        path = realpathSync(ws.path),
        rel = relative(base, path);
      if (
        !isAbsolute(base) ||
        !isAbsolute(path) ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel) ||
        !statSync(path).isDirectory() ||
        path !== realpathSync(String(plan.workspacePath))
      )
        fail("materialization_workspace_invalid");
    } catch {
      fail("materialization_workspace_invalid");
    }
    if (plan.workItem?.kind === "existing") {
      const w = db
        .prepare("SELECT * FROM work_items WHERE id=? AND root_id=?")
        .get(String(plan.workItem.id), String(row!.root_id));
      if (!w) fail("materialization_work_item_invalid");
      const previous = db
        .prepare(
          "SELECT d.agent_profile_id,d.workspace_id,d.capabilities_json,d.plan_json FROM decision_materializations m JOIN decisions d ON d.id=m.decision_id WHERE m.work_item_id=? ORDER BY m.created_at LIMIT 1",
        )
        .get(String(w!.id));
      if (
        !previous ||
        previous.agent_profile_id !== row!.agent_profile_id ||
        previous.workspace_id !== row!.workspace_id ||
        previous.capabilities_json !== row!.capabilities_json ||
        JSON.parse(String(previous.plan_json)).workspacePath !==
          plan.workspacePath
      )
        fail("materialization_work_item_untrusted");
      if (w!.status !== "completed") fail("materialization_work_item_busy");
      const last = db
        .prepare(
          "SELECT * FROM executions WHERE work_item_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(String(w!.id));
      if (!last || last.status !== "completed")
        return fail("materialization_work_item_busy");
      const executionId = randomUUID(),
        time = new Date(now()).toISOString();
      db.prepare(
        "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,agent_session_id,not_before,input,created_at,trigger_kind,parent_execution_id,retry_attempt) VALUES(?,?,?,'queued',?,?,?,?,?,'decision',?,0)",
      ).run(
        executionId,
        String(w!.id),
        Number(last.sequence) + 1,
        String(last.agent_profile_id),
        last.agent_session_id as string | null,
        time,
        "{}",
        time,
        String(last.id),
      );
      db.prepare(
        "UPDATE work_items SET status='active',updated_at=?,completed_at=NULL WHERE id=?",
      ).run(time, String(w!.id));
      db.prepare("INSERT INTO decision_materializations VALUES(?,?,?,?)").run(
        id,
        String(w!.id),
        executionId,
        time,
      );
      db.exec("COMMIT");
      return { workItemId: String(w!.id), executionId };
    }
    if (plan.workItem?.kind !== "create_work_item")
      fail("materialization_plan_invalid");
    const workId = randomUUID(),
      executionId = randomUUID(),
      profileId = `automation:${resultDigest({ id: row!.agent_profile_id, profile, workspacePath: plan.workspacePath, capabilities: plan.capabilities })}`,
      time = new Date(now()).toISOString();
    db.prepare(
      "INSERT INTO agent_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    ).run(
      profileId,
      String(row!.agent_profile_id),
      String(profile.adapter),
      profile.model ?? null,
      profile.reasoning ?? null,
      JSON.stringify({
        ...profile.config,
        isolation: profile.isolation ?? "trusted-local",
        workspaceRoot: plan.workspacePath,
      }),
    );
    db.prepare(
      "INSERT INTO work_items(id,title,status,route_id,agent_profile_id,created_at,updated_at,metadata,root_id) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      workId,
      String(row!.definition_id),
      "active",
      `automation:${row!.definition_id}`,
      profileId,
      time,
      time,
      JSON.stringify({
        eventId: row!.event_id,
        decisionId: id,
        authorizedPlan: plan,
        ...(snapshot.retryPolicy !== undefined
          ? { retryPolicy: snapshot.retryPolicy }
          : {}),
        ...(snapshot.instruction !== undefined
          ? { instruction: snapshot.instruction }
          : {}),
        ...(snapshot.notify !== undefined ? { notify: snapshot.notify } : {}),
        ...(snapshot.notifyOnCompleted !== undefined
          ? { notifyOnCompleted: snapshot.notifyOnCompleted }
          : {}),
      }),
      String(row!.root_id),
    );
    db.prepare(
      "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,not_before,input,created_at) VALUES(?,?,1,'queued',?,?,?,?)",
    ).run(executionId, workId, profileId, time, "{}", time);
    db.prepare("INSERT INTO decision_materializations VALUES(?,?,?,?)").run(
      id,
      workId,
      executionId,
      time,
    );
    db.prepare(
      "UPDATE automation_roots SET status='active',updated_at=?,version=version+1 WHERE id=? AND status='created'",
    ).run(time, String(row!.root_id));
    db.exec("COMMIT");
    return { workItemId: workId, executionId };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function processPendingMaterializations(
  db: DatabaseSync,
  config: Config,
  now: () => number,
  limit = 100,
  onError?: (id: string, code: string) => void,
): number {
  const rows = db
    .prepare(
      `SELECT d.id FROM decisions d JOIN automation_roots r ON r.id=d.root_id WHERE d.decision_type='authorize_execution' AND r.status IN ('created','active','waiting') AND NOT EXISTS(SELECT 1 FROM decision_materializations m WHERE m.decision_id=d.id) ORDER BY d.sequence LIMIT ?`,
    )
    .all(limit);
  let count = 0;
  for (const row of rows) {
    try {
      materializeDecision(db, String(row.id), config, now);
      count++;
    } catch (e) {
      onError?.(
        String(row.id),
        e instanceof TaskCircuitError ? e.code : "materialization_error",
      );
    }
  }
  return count;
}
