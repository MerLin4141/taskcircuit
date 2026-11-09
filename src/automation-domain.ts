import { DatabaseSync } from "node:sqlite";
import { loopConfig, frozenLoop } from "./loop-limits.js";

/** Migration 6 is valid only on a verified generation-2 store. */
export function migrateDomain(
  db: DatabaseSync,
  onStage?: (stage: string) => void,
): void {
  const version = Number(
    db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v,
  );
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
    throw new Error("domain migration requires a generation 2 store");
  if (
    version === 6 ||
    version === 7 ||
    version === 8 ||
    version === 9 ||
    version === 10
  ) {
    for (const table of [
      "automation_definitions",
      "automation_definition_versions",
      "automation_roots",
    ]) {
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
          )
          .get(table)
      )
        throw new Error("domain schema 6 is incomplete");
    }
    if (
      db
        .prepare("PRAGMA table_info(work_items)")
        .all()
        .find((x) => x.name === "root_id")?.notnull !== 1
    )
      throw new Error("domain schema 6 is incomplete");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("domain schema 6 foreign key check failed");
    return;
  }
  if (version !== 5)
    throw new Error("domain migration requires a generation 2 schema 5 store");
  const priorFK = db.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1;
  db.exec("PRAGMA foreign_keys=OFF");
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const current = Number(
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v,
    );
    if (
      current === 6 ||
      current === 7 ||
      current === 8 ||
      current === 9 ||
      current === 10
    ) {
      db.exec("COMMIT");
      inTransaction = false;
      return;
    }
    if (current !== 5) throw new Error("domain migration requires schema 5");
    if (
      db
        .prepare(
          "SELECT 1 FROM work_items WHERE status NOT IN ('active','waiting_input','waiting_schedule','completed','failed','cancelled') LIMIT 1",
        )
        .get()
    )
      throw new Error("domain migration found an unknown Work Item status");
    db.exec(`
      CREATE TABLE automation_definitions(id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, current_version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE automation_definition_versions(definition_id TEXT NOT NULL REFERENCES automation_definitions(id), version INTEGER NOT NULL, schema_version INTEGER NOT NULL, config_snapshot_json TEXT NOT NULL, policy_hash TEXT, created_at TEXT NOT NULL, PRIMARY KEY(definition_id,version));
      CREATE TRIGGER immutable_definition_versions_update BEFORE UPDATE ON automation_definition_versions BEGIN SELECT RAISE(ABORT,'automation_version_immutable'); END;
      CREATE TRIGGER immutable_definition_versions_delete BEFORE DELETE ON automation_definition_versions BEGIN SELECT RAISE(ABORT,'automation_version_immutable'); END;
    `);
    onStage?.("definitions-created");
    db.exec(`
      CREATE TABLE automation_roots(id TEXT PRIMARY KEY, definition_id TEXT NOT NULL, definition_version INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('manual','legacy','automation')), status TEXT NOT NULL CHECK(status IN ('created','active','waiting','blocked','completed','failed','cancelled','expired','budget_exhausted')), subject_scope TEXT, subject_key TEXT, predecessor_root_id TEXT REFERENCES automation_roots(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT, terminal_reason TEXT, version INTEGER NOT NULL DEFAULT 1, FOREIGN KEY(definition_id,definition_version) REFERENCES automation_definition_versions(definition_id,version));
      CREATE INDEX agent_sessions_external_identity ON agent_sessions(adapter,external_session_id);
      CREATE INDEX root_status_created ON automation_roots(status,created_at);
      CREATE INDEX root_subject ON automation_roots(definition_id,subject_scope,subject_key,created_at);
      CREATE TRIGGER root_version_immutable BEFORE UPDATE OF definition_id,definition_version ON automation_roots WHEN NEW.definition_id IS NOT OLD.definition_id OR NEW.definition_version IS NOT OLD.definition_version BEGIN SELECT RAISE(ABORT,'root_definition_version_immutable'); END;
      CREATE TRIGGER root_terminal_immutable BEFORE UPDATE OF status ON automation_roots WHEN OLD.status IN ('completed','failed','cancelled','expired','budget_exhausted') AND NEW.status<>OLD.status BEGIN SELECT RAISE(ABORT,'root_terminal'); END;
      INSERT INTO automation_definitions VALUES('system/manual','Manual','enabled',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT INTO automation_definition_versions VALUES('system/manual',1,1,'{}',NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    `);
    onStage?.("roots-created");
    const insertRoot =
      db.prepare(`INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,created_at,updated_at,terminal_at)
      SELECT 'legacy:'||id,'system/manual',1,'legacy',
      CASE WHEN EXISTS(SELECT 1 FROM agent_sessions a JOIN agent_sessions b ON a.adapter=b.adapter AND a.external_session_id=b.external_session_id AND a.work_item_id<>b.work_item_id WHERE a.work_item_id=work_items.id) THEN 'blocked'
      WHEN EXISTS(SELECT 1 FROM executions e WHERE e.work_item_id=work_items.id AND (e.status IN ('claimed','running') OR (e.status='failed' AND json_valid(e.error) AND json_extract(e.error,'$.code')='execution_outcome_unknown'))) THEN 'blocked'
      WHEN status IN ('waiting_input','waiting_schedule') THEN 'waiting' WHEN status IN ('completed','failed','cancelled') THEN status ELSE 'active' END,
      created_at,updated_at,CASE WHEN status='completed' THEN completed_at ELSE NULL END FROM work_items WHERE id=?`);
    let populated = false;
    for (const work of db
      .prepare("SELECT id FROM work_items ORDER BY id")
      .all()) {
      insertRoot.run(String(work.id));
      if (!populated) {
        populated = true;
        onStage?.("legacy-populating");
      }
    }
    if (!populated) onStage?.("legacy-populating");
    onStage?.("before-work-constraint");
    db.exec(`
      CREATE TABLE work_items_new(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,route_id TEXT NOT NULL,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,metadata TEXT NOT NULL,root_id TEXT NOT NULL REFERENCES automation_roots(id),subject_scope TEXT,subject_key TEXT,CHECK((subject_scope IS NULL) = (subject_key IS NULL)));
      INSERT INTO work_items_new SELECT *, 'legacy:'||id,NULL,NULL FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_new RENAME TO work_items;
      CREATE TRIGGER changes_work_insert AFTER INSERT ON work_items BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('work_item.created','work_item',NEW.id,NEW.id,json_object('status',NEW.status),NEW.created_at); END;
      CREATE TRIGGER changes_work_status AFTER UPDATE OF status ON work_items WHEN OLD.status<>NEW.status BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('work_item.status_changed','work_item',NEW.id,NEW.id,json_object('status',NEW.status),NEW.updated_at); END;
      CREATE INDEX work_items_root ON work_items(root_id);
      CREATE UNIQUE INDEX work_items_root_subject ON work_items(root_id,subject_scope,subject_key) WHERE subject_scope IS NOT NULL AND subject_key IS NOT NULL;
      CREATE TRIGGER session_external_identity_insert BEFORE INSERT ON agent_sessions WHEN EXISTS(SELECT 1 FROM agent_sessions WHERE adapter=NEW.adapter AND external_session_id=NEW.external_session_id AND work_item_id<>NEW.work_item_id) BEGIN SELECT RAISE(ABORT,'root_session_mismatch'); END;
      CREATE TRIGGER session_external_identity_update BEFORE UPDATE OF adapter,external_session_id,work_item_id ON agent_sessions WHEN EXISTS(SELECT 1 FROM agent_sessions WHERE id<>NEW.id AND adapter=NEW.adapter AND external_session_id=NEW.external_session_id AND work_item_id<>NEW.work_item_id) BEGIN SELECT RAISE(ABORT,'root_session_mismatch'); END;
      CREATE TRIGGER work_item_root_immutable BEFORE UPDATE OF root_id ON work_items WHEN NEW.root_id IS NOT OLD.root_id BEGIN SELECT RAISE(ABORT,'root_ownership_immutable'); END;
      CREATE TRIGGER execution_session_insert BEFORE INSERT ON executions WHEN NEW.agent_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_sessions WHERE id=NEW.agent_session_id AND work_item_id=NEW.work_item_id) BEGIN SELECT RAISE(ABORT,'root_session_mismatch'); END;
      CREATE TRIGGER execution_session_update BEFORE UPDATE OF agent_session_id,work_item_id ON executions WHEN NEW.agent_session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agent_sessions WHERE id=NEW.agent_session_id AND work_item_id=NEW.work_item_id) BEGIN SELECT RAISE(ABORT,'root_session_mismatch'); END;
      CREATE TRIGGER root_predecessor_immutable BEFORE UPDATE OF predecessor_root_id ON automation_roots WHEN NEW.predecessor_root_id IS NOT OLD.predecessor_root_id BEGIN SELECT RAISE(ABORT,'invalid_root_predecessor'); END;
      CREATE TRIGGER root_predecessor_valid BEFORE INSERT ON automation_roots WHEN NEW.predecessor_root_id IS NOT NULL AND (NEW.predecessor_root_id=NEW.id OR NOT EXISTS(SELECT 1 FROM automation_roots WHERE id=NEW.predecessor_root_id AND status IN ('completed','failed','cancelled','expired','budget_exhausted'))) BEGIN SELECT RAISE(ABORT,'invalid_root_predecessor'); END;
      CREATE VIEW root_status_projection AS
      SELECT r.id, CASE
          WHEN NOT EXISTS(SELECT 1 FROM work_items WHERE root_id=r.id) THEN 'created'
          WHEN EXISTS(SELECT 1 FROM work_items w JOIN executions e ON e.work_item_id=w.id WHERE w.root_id=r.id AND e.status='failed' AND json_valid(e.error) AND json_extract(e.error,'$.code')='execution_outcome_unknown') THEN 'blocked'
          WHEN EXISTS(SELECT 1 FROM work_items WHERE root_id=r.id AND status='active') THEN 'active'
          WHEN EXISTS(SELECT 1 FROM work_items WHERE root_id=r.id AND status IN ('waiting_input','waiting_schedule')) THEN 'waiting'
          WHEN EXISTS(SELECT 1 FROM interactions i JOIN work_items w ON w.id=i.work_item_id WHERE w.root_id=r.id AND i.status='open') THEN 'waiting'
          WHEN EXISTS(SELECT 1 FROM schedules s JOIN work_items w ON s.owner_kind='work_item' AND s.owner_id=w.id WHERE w.root_id=r.id AND s.status IN ('active','paused')) THEN 'waiting'
          WHEN EXISTS(SELECT 1 FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE w.root_id=r.id AND e.status NOT IN ('completed','failed','cancelled','waiting_input')) THEN 'waiting'
          WHEN EXISTS(SELECT 1 FROM work_items WHERE root_id=r.id AND status='failed') THEN 'failed'
          WHEN EXISTS(SELECT 1 FROM work_items WHERE root_id=r.id AND status='cancelled') THEN 'cancelled'
          ELSE 'completed' END AS projected_status FROM automation_roots r;
      CREATE TRIGGER root_status_from_work AFTER UPDATE OF status ON work_items WHEN NEW.status <> OLD.status
      BEGIN
        UPDATE automation_roots SET status=(SELECT projected_status FROM root_status_projection WHERE id=NEW.root_id), updated_at=NEW.updated_at, version=version+1 WHERE id=NEW.root_id AND status NOT IN ('blocked','completed','failed','cancelled','expired','budget_exhausted');
      END;
      CREATE TRIGGER root_status_from_execution AFTER UPDATE OF status ON executions WHEN NEW.status <> OLD.status
      BEGIN
        UPDATE automation_roots SET status=(SELECT projected_status FROM root_status_projection WHERE id=automation_roots.id), version=version+1 WHERE id=(SELECT root_id FROM work_items WHERE id=NEW.work_item_id) AND status NOT IN ('blocked','completed','failed','cancelled','expired','budget_exhausted');
      END;
      CREATE TRIGGER root_status_from_interaction AFTER UPDATE OF status ON interactions WHEN NEW.status <> OLD.status
      BEGIN
        UPDATE automation_roots SET status=(SELECT projected_status FROM root_status_projection WHERE id=automation_roots.id), version=version+1 WHERE id=(SELECT root_id FROM work_items WHERE id=NEW.work_item_id) AND status NOT IN ('blocked','completed','failed','cancelled','expired','budget_exhausted');
      END;
      CREATE TRIGGER root_status_from_schedule AFTER UPDATE OF status ON schedules WHEN NEW.status <> OLD.status AND NEW.owner_kind='work_item'
      BEGIN
        UPDATE automation_roots SET status=(SELECT projected_status FROM root_status_projection WHERE id=automation_roots.id), version=version+1 WHERE id=(SELECT root_id FROM work_items WHERE id=NEW.owner_id) AND status NOT IN ('blocked','completed','failed','cancelled','expired','budget_exhausted');
      END;
      CREATE TRIGGER work_item_root_active BEFORE INSERT ON work_items WHEN NOT EXISTS(SELECT 1 FROM automation_roots WHERE id=NEW.root_id AND status IN ('created','active','waiting')) BEGIN SELECT RAISE(ABORT,'root_terminal'); END;
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("domain migration foreign key check failed");
    if (
      db
        .prepare(
          "SELECT 1 FROM executions e JOIN agent_sessions s ON s.id=e.agent_session_id WHERE e.work_item_id<>s.work_item_id LIMIT 1",
        )
        .get()
    )
      throw new Error("domain migration found a mismatched historical session");
    onStage?.("before-schema-update");
    db.prepare("INSERT INTO schema_migrations VALUES(6,?)").run(
      new Date().toISOString(),
    );
    db.exec("COMMIT");
    inTransaction = false;
  } catch (e) {
    if (inTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    if (priorFK) db.exec("PRAGMA foreign_keys=ON");
  }
}
import { TaskCircuitError } from "./domain.js";
export type RootState =
  | "created"
  | "active"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "budget_exhausted";
const transitions: Record<RootState, readonly RootState[]> = {
  created: ["active", "blocked", "failed", "cancelled", "expired"],
  active: [
    "waiting",
    "blocked",
    "completed",
    "failed",
    "cancelled",
    "expired",
    "budget_exhausted",
  ],
  waiting: [
    "active",
    "blocked",
    "failed",
    "cancelled",
    "expired",
    "budget_exhausted",
  ],
  blocked: [
    "active",
    "waiting",
    "failed",
    "cancelled",
    "expired",
    "budget_exhausted",
  ],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
  budget_exhausted: [],
};
export function canTransitionRoot(from: RootState, to: RootState): boolean {
  return transitions[from]?.includes(to) ?? false;
}
const terminal = (s: string) =>
  ["completed", "failed", "cancelled", "expired", "budget_exhausted"].includes(
    s,
  );
function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function createDefinition(
  db: DatabaseSync,
  id: string,
  name: string,
  snapshot: unknown,
  at: string,
): void {
  loopConfig(snapshot);
  transaction(db, () => {
    db.prepare(
      "INSERT INTO automation_definitions VALUES(?,?,'enabled',1,?,?)",
    ).run(id, name, at, at);
    db.prepare(
      "INSERT INTO automation_definition_versions VALUES(?,1,1,?,NULL,?)",
    ).run(id, JSON.stringify(snapshot), at);
  });
}
export function addDefinitionVersion(
  db: DatabaseSync,
  id: string,
  version: number,
  snapshot: unknown,
  at: string,
): void {
  loopConfig(snapshot);
  transaction(db, () => {
    const current = db
      .prepare("SELECT current_version FROM automation_definitions WHERE id=?")
      .get(id);
    if (!current)
      throw new TaskCircuitError(
        "automation_not_found",
        "Definition not found",
        404,
      );
    if (version !== Number(current.current_version) + 1)
      throw new TaskCircuitError(
        "automation_version_conflict",
        "Invalid definition version",
        409,
      );
    db.prepare(
      "INSERT INTO automation_definition_versions VALUES(?,?,1,?,NULL,?)",
    ).run(id, version, JSON.stringify(snapshot), at);
    db.prepare(
      "UPDATE automation_definitions SET current_version=?,updated_at=? WHERE id=?",
    ).run(version, at, id);
  });
}
export function createRoot(
  db: DatabaseSync,
  id: string,
  definitionId: string,
  version: number,
  predecessor: string | null,
  at: string,
): void {
  transaction(db, () => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM automation_definition_versions v JOIN automation_definitions d ON d.id=v.definition_id WHERE v.definition_id=? AND v.version=? AND d.status='enabled'",
        )
        .get(definitionId, version)
    )
      throw new TaskCircuitError(
        "automation_version_not_found",
        "Definition version unavailable",
        404,
      );
    if (predecessor) {
      const previous = db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(predecessor);
      if (id === predecessor || !previous || !terminal(String(previous.status)))
        throw new TaskCircuitError(
          "invalid_root_predecessor",
          "Predecessor must exist and be terminal",
          409,
        );
    }
    const limitsEnabled = db
      .prepare("PRAGMA table_info(automation_roots)")
      .all()
      .some((x) => x.name === "max_runs");
    if (limitsEnabled) {
      const v = db
        .prepare(
          "SELECT config_snapshot_json FROM automation_definition_versions WHERE definition_id=? AND version=?",
        )
        .get(definitionId, version)!;
      const limits = frozenLoop(JSON.parse(String(v.config_snapshot_json)), at);
      db.prepare(
        "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,predecessor_root_id,created_at,updated_at,max_runs,deadline_at) VALUES(?,?,?,'automation','created',?,?,?,?,?)",
      ).run(
        id,
        definitionId,
        version,
        predecessor,
        at,
        at,
        limits.maxRuns,
        limits.deadlineAt,
      );
    } else
      db.prepare(
        "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,predecessor_root_id,created_at,updated_at) VALUES(?,?,?,'automation','created',?,?,?)",
      ).run(id, definitionId, version, predecessor, at, at);
  });
}
export function transitionRoot(
  db: DatabaseSync,
  id: string,
  next: RootState,
): void {
  transaction(db, () => {
    const root = db
      .prepare("SELECT status FROM automation_roots WHERE id=?")
      .get(id);
    if (!root)
      throw new TaskCircuitError("root_not_found", "Root not found", 404);
    if (next === "cancelled")
      throw new TaskCircuitError(
        "root_cancel_not_supported",
        "Root-wide cancellation is not implemented",
        409,
      );
    if (!canTransitionRoot(root.status as RootState, next))
      throw new TaskCircuitError(
        "invalid_root_transition",
        "Invalid Root transition",
        409,
      );
    if (root.status === "blocked" && (next === "active" || next === "waiting"))
      throw new TaskCircuitError(
        "invalid_root_transition",
        "Blocked Root requires verified operator evidence",
        409,
      );
    if (
      root.status === "created" &&
      next === "active" &&
      !db.prepare("SELECT 1 FROM work_items WHERE root_id=? LIMIT 1").get(id)
    )
      throw new TaskCircuitError(
        "invalid_root_transition",
        "An active Root requires a Work Item",
        409,
      );
    if (terminal(next) && rootHasActiveExecution(db, id))
      throw new TaskCircuitError(
        "invalid_root_transition",
        "Root has an active or uncertain execution",
        409,
      );
    if (next === "completed") {
      const count = Number(
        db.prepare("SELECT COUNT(*) n FROM work_items WHERE root_id=?").get(id)
          ?.n,
      );
      const unfinished = db
        .prepare(
          "SELECT 1 FROM work_items WHERE root_id=? AND status<>'completed' LIMIT 1",
        )
        .get(id);
      const open = db
        .prepare(
          "SELECT 1 FROM interactions i JOIN work_items w ON w.id=i.work_item_id WHERE w.root_id=? AND i.status='open' LIMIT 1",
        )
        .get(id);
      const scheduled = db
        .prepare(
          "SELECT 1 FROM schedules s JOIN work_items w ON s.owner_kind='work_item' AND s.owner_id=w.id WHERE w.root_id=? AND s.status IN ('active','paused') LIMIT 1",
        )
        .get(id);
      const execution = db
        .prepare(
          "SELECT 1 FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE w.root_id=? AND (e.status NOT IN ('completed','cancelled','failed','waiting_input') OR (e.status='failed' AND json_valid(e.error) AND json_extract(e.error,'$.code')='execution_outcome_unknown')) LIMIT 1",
        )
        .get(id);
      const materializationTable = db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='decision_materializations'",
        )
        .get();
      const pending =
        materializationTable &&
        db
          .prepare(
            "SELECT 1 FROM decisions d WHERE d.root_id=? AND d.decision_type='authorize_execution' AND NOT EXISTS(SELECT 1 FROM decision_materializations m WHERE m.decision_id=d.id) LIMIT 1",
          )
          .get(id);
      if (!count || unfinished || open || scheduled || execution || pending)
        throw new TaskCircuitError(
          "invalid_root_transition",
          "Root still has unfinished work",
          409,
        );
    }
    db.prepare(
      "UPDATE automation_roots SET status=?,updated_at=?,terminal_at=?,version=version+1 WHERE id=?",
    ).run(
      next,
      new Date().toISOString(),
      terminal(next) ? new Date().toISOString() : null,
      id,
    );
  });
}
export function rootHasActiveExecution(db: DatabaseSync, id: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM executions e JOIN work_items w ON e.work_item_id=w.id WHERE w.root_id=? AND (e.status IN ('claimed','running') OR (e.status='failed' AND json_valid(e.error) AND json_extract(e.error,'$.code')='execution_outcome_unknown')) LIMIT 1`,
    )
    .get(id);
}
export function createWorkItemForRoot(
  db: DatabaseSync,
  input: {
    rootId: string;
    id: string;
    executionId: string;
    profileId: string;
    at: string;
    subjectScope?: string;
    subjectKey?: string;
  },
): void {
  transaction(db, () => {
    if ((input.subjectScope === undefined) !== (input.subjectKey === undefined))
      throw new TaskCircuitError(
        "invalid_subject",
        "Subject scope and key must be provided together",
        400,
      );
    const root = db
      .prepare("SELECT status FROM automation_roots WHERE id=?")
      .get(input.rootId);
    if (!root)
      throw new TaskCircuitError("root_not_found", "Root not found", 404);
    if (!["created", "active", "waiting"].includes(String(root.status)))
      throw new TaskCircuitError(
        "root_terminal",
        "Root cannot accept work",
        409,
      );
    db.prepare(
      "INSERT INTO work_items(id,title,status,route_id,agent_profile_id,created_at,updated_at,completed_at,metadata,root_id,subject_scope,subject_key) VALUES(?,?,'active',?,?,?, ?,NULL,'{}',?,?,?)",
    ).run(
      input.id,
      input.id,
      "domain",
      input.profileId,
      input.at,
      input.at,
      input.rootId,
      input.subjectScope ?? null,
      input.subjectKey ?? null,
    );
    db.prepare(
      "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,not_before,input,created_at) VALUES(?,?,1,'queued',?,?,'{}',?)",
    ).run(input.executionId, input.id, input.profileId, input.at, input.at);
    db.prepare(
      "UPDATE automation_roots SET status='active',updated_at=?,version=version+1 WHERE id=?",
    ).run(input.at, input.rootId);
  });
}
export function getAutomation(db: DatabaseSync, id: string) {
  return (
    db.prepare("SELECT * FROM automation_definitions WHERE id=?").get(id) ??
    null
  );
}
export function getAutomationVersion(
  db: DatabaseSync,
  id: string,
  version: number,
) {
  return (
    db
      .prepare(
        "SELECT * FROM automation_definition_versions WHERE definition_id=? AND version=?",
      )
      .get(id, version) ?? null
  );
}
export function getRoot(db: DatabaseSync, id: string) {
  return (
    db.prepare("SELECT * FROM automation_roots WHERE id=?").get(id) ?? null
  );
}
export function listRootWorkItems(db: DatabaseSync, id: string) {
  return db
    .prepare("SELECT * FROM work_items WHERE root_id=? ORDER BY created_at,id")
    .all(id);
}
