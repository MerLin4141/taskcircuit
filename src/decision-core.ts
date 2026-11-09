import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { resultDigest } from "./result-receipt.js";
import { TaskCircuitError } from "./domain.js";
import {
  evaluatePolicy,
  POLICY_ENGINE_VERSION,
  type PolicyInput,
} from "./policy-core.js";
import type { Config } from "./config.js";

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (code: string, message: string, status = 400): never => {
  throw new TaskCircuitError(code, message, status);
};
const version = (db: DatabaseSync) =>
  Number(
    db.prepare("SELECT COALESCE(MAX(version),0) v FROM schema_migrations").get()
      ?.v,
  );
export type DecisionRequest = {
  requestId: string;
  eventId: string;
  rootId: string;
  generation: number;
  expectedRootVersion?: number;
};
export type DecisionOptions = {
  config: Config;
  now: () => number;
  onStage?: (stage: string) => void;
};
export function migrateDecisionCore(
  db: DatabaseSync,
  onStage?: (stage: string) => void,
): void {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
    throw Error("decision migration requires SQLite foreign keys");
  const generation = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='taskcircuit_generation'",
    )
    .get();
  if (
    !generation ||
    db.prepare("SELECT generation FROM taskcircuit_generation").get()
      ?.generation !== 2
  )
    throw Error("decision migration requires generation 2");
  if (version(db) > 10)
    fail(
      "database_schema_too_new",
      "Database schema is newer than this TaskCircuit binary supports. Upgrade TaskCircuit before opening this database.",
      409,
    );
  if (version(db) === 8 || version(db) === 9 || version(db) === 10) {
    for (const name of ["decisions", "decision_requests", "decision_runtime"])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
          )
          .get(name)
      )
        throw Error("decision schema 8 is incomplete");
    for (const name of [
      "decision_immutable_update",
      "decision_immutable_delete",
    ])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?",
          )
          .get(name)
      )
        throw Error("decision schema 8 guard missing");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("decision schema 8 foreign key check failed");
    return;
  }
  if (version(db) !== 7) throw Error("decision migration requires schema 7");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version(db) === 8 || version(db) === 9 || version(db) === 10) {
      db.exec("COMMIT");
      return;
    }
    if (version(db) !== 7) throw Error("decision migration requires schema 7");
    db.exec(
      `CREATE TABLE decisions(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,event_id TEXT NOT NULL,root_id TEXT NOT NULL,definition_id TEXT NOT NULL,definition_version INTEGER NOT NULL,evaluation_generation INTEGER NOT NULL CHECK(evaluation_generation>0),root_revision INTEGER NOT NULL,policy_version TEXT NOT NULL,policy_hash TEXT NOT NULL,trusted_config_hash TEXT NOT NULL,decision_type TEXT NOT NULL CHECK(decision_type IN ('authorize_execution','ignore','block','wait','reject')),reason_code TEXT NOT NULL,agent_profile_id TEXT,workspace_id TEXT,capabilities_json TEXT NOT NULL,plan_json TEXT,plan_digest TEXT,decision_digest TEXT NOT NULL,request_digest TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(event_id,root_id) REFERENCES event_root_links(event_id,root_id),FOREIGN KEY(definition_id,definition_version) REFERENCES automation_definition_versions(definition_id,version),UNIQUE(event_id,root_id,evaluation_generation));`,
    );
    onStage?.("decisions-created");
    db.exec(`CREATE TABLE decision_requests(request_id TEXT PRIMARY KEY,request_digest TEXT NOT NULL,decision_id TEXT NOT NULL REFERENCES decisions(id),created_at TEXT NOT NULL);
      CREATE TABLE decision_runtime(id INTEGER PRIMARY KEY CHECK(id=1),activation_sequence INTEGER NOT NULL);
      INSERT INTO decision_runtime VALUES(1,(SELECT COALESCE(MAX(sequence),0) FROM event_root_links));
      CREATE INDEX decision_root_sequence ON decisions(root_id,sequence);
      CREATE INDEX decision_event_root ON decisions(event_id,root_id,evaluation_generation);`);
    onStage?.("indexes-created");
    db.exec(`CREATE TRIGGER decision_immutable_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT,'decision_immutable'); END;
      CREATE TRIGGER decision_immutable_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT,'decision_immutable'); END;
      CREATE TRIGGER decision_request_immutable_update BEFORE UPDATE ON decision_requests BEGIN SELECT RAISE(ABORT,'decision_immutable'); END;
      CREATE TRIGGER decision_request_immutable_delete BEFORE DELETE ON decision_requests BEGIN SELECT RAISE(ABORT,'decision_immutable'); END;
      CREATE TRIGGER decision_root_definition_guard BEFORE INSERT ON decisions WHEN NOT EXISTS(SELECT 1 FROM automation_roots WHERE id=NEW.root_id AND definition_id=NEW.definition_id AND definition_version=NEW.definition_version) BEGIN SELECT RAISE(ABORT,'decision_root_mismatch'); END;`);
    onStage?.("constraints-created");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("decision migration foreign key check failed");
    onStage?.("before-schema-update");
    db.prepare("INSERT INTO schema_migrations VALUES(8,?)").run(
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
function decisionRow(row: Row): Row {
  return {
    id: row.id,
    sequence: row.sequence,
    eventId: row.event_id,
    rootId: row.root_id,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    generation: row.evaluation_generation,
    rootRevision: row.root_revision,
    policyVersion: row.policy_version,
    policyHash: row.policy_hash,
    trustedConfigHash: row.trusted_config_hash,
    type: row.decision_type,
    reasonCode: row.reason_code,
    agentProfileId: row.agent_profile_id,
    workspaceId: row.workspace_id,
    capabilities: JSON.parse(String(row.capabilities_json)),
    plan: row.plan_json ? JSON.parse(String(row.plan_json)) : null,
    planDigest: row.plan_digest,
    decisionDigest: row.decision_digest,
    createdAt: row.created_at,
  };
}
export function getDecision(db: DatabaseSync, id: string): Row | null {
  const row = db.prepare("SELECT * FROM decisions WHERE id=?").get(id) as
    Row | undefined;
  return row ? decisionRow(row) : null;
}
export function listRootDecisions(
  db: DatabaseSync,
  rootId: string,
  after = 0,
): Row[] {
  return (
    db
      .prepare(
        "SELECT * FROM decisions WHERE root_id=? AND sequence>? ORDER BY sequence LIMIT 100",
      )
      .all(rootId, after) as Row[]
  ).map(decisionRow);
}
function findInput(
  db: DatabaseSync,
  eventId: string,
  rootId: string,
): Row | undefined {
  return db
    .prepare(
      `SELECT e.id event_id,e.type event_type,e.schema_version,r.id root_id,r.status root_status,r.version root_revision,r.definition_id,r.definition_version,d.status definition_status,v.config_snapshot_json FROM event_root_links l JOIN events e ON e.id=l.event_id JOIN automation_roots r ON r.id=l.root_id JOIN automation_definitions d ON d.id=r.definition_id JOIN automation_definition_versions v ON v.definition_id=r.definition_id AND v.version=r.definition_version WHERE l.event_id=? AND l.root_id=? AND e.schema_version=1`,
    )
    .get(eventId, rootId) as Row | undefined;
}
function inspectFacts(
  db: DatabaseSync,
  raw: Row,
  config: Config,
): {
  facts: PolicyInput["facts"];
  workspacePath: string | null;
  trustedConfigHash: string;
} {
  let definition: unknown;
  try {
    definition = JSON.parse(String(raw.config_snapshot_json));
  } catch {
    definition = null;
  }
  const policy =
    object(definition) && object(definition.policy) ? definition.policy : {};
  const profileId =
    typeof policy.agentProfileId === "string" ? policy.agentProfileId : "";
  const profile = config.agents[profileId];
  const profileMatches =
    !!profile &&
    object(policy.agentProfileSnapshot) &&
    resultDigest(profile) === resultDigest(policy.agentProfileSnapshot);
  const workspaceId =
    typeof policy.workspaceId === "string" ? policy.workspaceId : "";
  const ws = config.policyWorkspaces?.[workspaceId];
  let workspaceValid = false,
    workspaceMatches = false,
    workspacePath: string | null = null;
  try {
    if (
      ws &&
      isAbsolute(ws.path) &&
      isAbsolute(ws.allowedRoot) &&
      typeof policy.workspacePath === "string" &&
      typeof policy.workspaceAllowedRoot === "string" &&
      isAbsolute(policy.workspacePath) &&
      isAbsolute(policy.workspaceAllowedRoot)
    ) {
      const actual = realpathSync(ws.path),
        allowed = realpathSync(ws.allowedRoot),
        snapPath = realpathSync(policy.workspacePath),
        snapRoot = realpathSync(policy.workspaceAllowedRoot);
      const rel = relative(allowed, actual);
      workspaceValid =
        statSync(actual).isDirectory() &&
        statSync(allowed).isDirectory() &&
        rel !== ".." &&
        !rel.startsWith(`..${sep}`) &&
        !isAbsolute(rel);
      workspaceMatches = actual === snapPath && allowed === snapRoot;
      if (workspaceValid && workspaceMatches) workspacePath = actual;
    }
  } catch {
    workspaceValid = false;
  }
  const work = db
    .prepare("SELECT id FROM work_items WHERE root_id=? ORDER BY id LIMIT 2")
    .all(String(raw.root_id));
  const allowedByLocal = Array.isArray(ws?.allowedCapabilities)
    ? ws.allowedCapabilities.filter((x): x is string => typeof x === "string")
    : [];
  const trustedConfigHash = resultDigest({
    profile: profile ?? null,
    workspace: ws ?? null,
  });
  return {
    facts: {
      agentRegistered: !!profile,
      profileMatches,
      workspaceValid,
      workspaceMatches,
      allowedByLocal,
      existingWorkItemId: work.length === 1 ? String(work[0].id) : null,
      workItemAmbiguous: work.length > 1,
    },
    workspacePath,
    trustedConfigHash,
  };
}
function validRequest(r: DecisionRequest): boolean {
  return (
    !!r &&
    typeof r.requestId === "string" &&
    r.requestId.length > 0 &&
    r.requestId.length <= 256 &&
    !/[\u0000-\u001f]/.test(r.requestId) &&
    typeof r.eventId === "string" &&
    r.eventId.length > 0 &&
    typeof r.rootId === "string" &&
    r.rootId.length > 0 &&
    Number.isSafeInteger(r.generation) &&
    r.generation > 0 &&
    (r.expectedRootVersion === undefined ||
      (Number.isSafeInteger(r.expectedRootVersion) &&
        r.expectedRootVersion > 0))
  );
}
export function evaluateDecision(
  db: DatabaseSync,
  request: DecisionRequest,
  options: DecisionOptions,
): { status: "created" | "duplicate"; decision: Row } {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
    throw Error("decision requires SQLite foreign keys");
  if (!validRequest(request)) return fail("decision_invalid", "决策请求不正确");
  const requestDigest = resultDigest({
    eventId: request.eventId,
    rootId: request.rootId,
    generation: request.generation,
    expectedRootVersion: request.expectedRootVersion ?? null,
  });
  const lookup = (): Row | undefined =>
    db
      .prepare(
        "SELECT d.*,r.request_digest AS recorded_request_digest FROM decision_requests r JOIN decisions d ON d.id=r.decision_id WHERE r.request_id=?",
      )
      .get(request.requestId) as Row | undefined;
  const early = lookup();
  if (early) {
    if (early.recorded_request_digest !== requestDigest)
      fail("decision_request_conflict", "决策请求标识冲突", 409);
    return { status: "duplicate", decision: decisionRow(early) };
  }
  const input = findInput(db, request.eventId, request.rootId);
  if (!input)
    return fail("decision_event_root_invalid", "事件与 Root 未关联", 404);
  if (
    request.expectedRootVersion !== undefined &&
    input.root_revision !== request.expectedRootVersion
  )
    return fail("decision_stale_input", "Root 版本已变化", 409);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(String(input.config_snapshot_json));
  } catch {
    snapshot = null;
  }
  const snapshotHash = resultDigest(snapshot);
  const policyVersion = `${POLICY_ENGINE_VERSION}:${snapshotHash}`;
  const { facts, workspacePath, trustedConfigHash } = inspectFacts(
    db,
    input,
    options.config,
  );
  const proposal = evaluatePolicy({
    rootStatus: String(input.root_status),
    automationEnabled: input.definition_status === "enabled",
    eventType: String(input.event_type),
    definition: snapshot,
    facts,
  });
  const plan = proposal.plan
    ? {
        ...proposal.plan,
        rootId: request.rootId,
        eventId: request.eventId,
        workspacePath,
        policyVersion,
        reasonCode: proposal.reasonCode,
      }
    : null;
  const planDigest = plan ? resultDigest(plan) : null;
  const payload = {
    eventId: request.eventId,
    rootId: request.rootId,
    definitionId: String(input.definition_id),
    definitionVersion: Number(input.definition_version),
    generation: request.generation,
    rootRevision: Number(input.root_revision),
    policyVersion,
    policyHash: snapshotHash,
    trustedConfigHash,
    type: proposal.type,
    reasonCode: proposal.reasonCode,
    plan,
    planDigest,
  };
  const decisionDigest = resultDigest(payload);
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = lookup();
    if (existing) {
      if (existing.recorded_request_digest !== requestDigest)
        fail("decision_request_conflict", "决策请求标识冲突", 409);
      db.exec("COMMIT");
      return { status: "duplicate", decision: decisionRow(existing) };
    }
    const natural = db
      .prepare(
        "SELECT * FROM decisions WHERE event_id=? AND root_id=? AND evaluation_generation=?",
      )
      .get(request.eventId, request.rootId, request.generation) as
      Row | undefined;
    if (natural) {
      if (natural.request_digest !== requestDigest)
        fail("decision_request_conflict", "同一评估代次内容冲突", 409);
      db.prepare("INSERT INTO decision_requests VALUES(?,?,?,?)").run(
        request.requestId,
        requestDigest,
        String(natural.id),
        new Date(options.now()).toISOString(),
      );
      db.exec("COMMIT");
      return { status: "duplicate", decision: decisionRow(natural) };
    }
    const fresh = findInput(db, request.eventId, request.rootId);
    if (
      !fresh ||
      fresh.root_revision !== input.root_revision ||
      fresh.root_status !== input.root_status ||
      fresh.definition_status !== input.definition_status ||
      fresh.config_snapshot_json !== input.config_snapshot_json
    )
      fail("decision_stale_input", "决策输入已变化", 409);
    const id = randomUUID(),
      time = new Date(options.now()).toISOString();
    db.prepare(
      `INSERT INTO decisions(id,event_id,root_id,definition_id,definition_version,evaluation_generation,root_revision,policy_version,policy_hash,trusted_config_hash,decision_type,reason_code,agent_profile_id,workspace_id,capabilities_json,plan_json,plan_digest,decision_digest,request_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      request.eventId,
      request.rootId,
      String(input.definition_id),
      Number(input.definition_version),
      request.generation,
      Number(input.root_revision),
      policyVersion,
      snapshotHash,
      trustedConfigHash,
      proposal.type,
      proposal.reasonCode,
      proposal.plan?.agentProfileId ?? null,
      proposal.plan?.workspaceId ?? null,
      JSON.stringify(proposal.plan?.capabilities ?? []),
      plan ? JSON.stringify(plan) : null,
      planDigest,
      decisionDigest,
      requestDigest,
      time,
    );
    options.onStage?.("decision-inserted");
    db.prepare("INSERT INTO decision_requests VALUES(?,?,?,?)").run(
      request.requestId,
      requestDigest,
      id,
      time,
    );
    options.onStage?.("request-inserted");
    const result = getDecision(db, id)!;
    db.exec("COMMIT");
    return { status: "created", decision: result };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function processPendingDecisions(
  db: DatabaseSync,
  options: DecisionOptions,
  limit = 100,
): number {
  const pending = db
    .prepare(
      `SELECT l.sequence,l.event_id,l.root_id FROM event_root_links l JOIN event_deliveries d ON d.event_id=l.event_id WHERE d.status='processed' AND l.sequence>(SELECT activation_sequence FROM decision_runtime WHERE id=1) AND NOT EXISTS(SELECT 1 FROM decisions x WHERE x.event_id=l.event_id AND x.root_id=l.root_id AND x.evaluation_generation=1) ORDER BY l.sequence LIMIT ?`,
    )
    .all(limit);
  let count = 0;
  for (const p of pending) {
    evaluateDecision(
      db,
      {
        requestId: `auto:${p.sequence}`,
        eventId: String(p.event_id),
        rootId: String(p.root_id),
        generation: 1,
      },
      options,
    );
    count++;
  }
  return count;
}
