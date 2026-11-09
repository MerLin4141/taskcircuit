import { frozenLoop } from "./loop-limits.js";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { TaskCircuitError } from "./domain.js";

export const EVENT_PAYLOAD_LIMIT = 65536;
export type TrustContext =
  | "trusted_local_cli"
  | "trusted_internal"
  | "external_untrusted"
  | "agent_feedback";
export type TrustedSource = {
  sourceInstance: string;
  trustContext: TrustContext;
  originRootId?: string;
};
export type EventEnvelope = {
  sourceEventId: string;
  type: string;
  payload: unknown;
  automationId?: string;
  automationIds?: string[];
  correlationKey?: string;
  occurredAt?: string;
  parentEventId?: string;
  displaySource?: string;
};
export type EventOptions = {
  knownTypes: ReadonlySet<string>;
  now: () => number;
  onStage?: (stage: string) => void;
};
export type EventResult = {
  status: "accepted" | "unroutable" | "duplicate" | "conflict";
  eventId: string;
  rootId: string | null;
  createdRoot: boolean;
  predecessorRootId: string | null;
  receivedAt: string;
  roots: Array<{
    rootId: string;
    createdRoot: boolean;
    predecessorRootId: string | null;
  }>;
};
const err = (code: string, message: string, status = 400): never => {
  throw new TaskCircuitError(code, message, status);
};
const identity = (v: unknown, limit = 256): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= limit &&
  !/[\u0000-\u001f\u007f]/.test(v);
const eventType = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const secretKey =
  /(?:^|[_-])(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|client[_-]?secret|private[_-]?key|credential)(?:$|[_-])/i;
const secretValue =
  /(?:\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9_]{16,}|\bgithub_pat_[A-Za-z0-9_]{16,}|\bBearer\s+[^\s]{8,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----)/i;
function canonical(v: unknown): string {
  if (typeof v === "string" && secretValue.test(v))
    return err("event_invalid", "事件内容不能包含凭据");
  if (v === null || typeof v === "string" || typeof v === "boolean")
    return JSON.stringify(v);
  if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (
    typeof v === "object" &&
    v !== null &&
    Object.getPrototypeOf(v) === Object.prototype
  ) {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => {
        if (secretKey.test(k.replace(/([a-z])([A-Z])/g, "$1_$2")))
          err("event_invalid", "事件内容不能包含凭据字段");
        return `${JSON.stringify(k)}:${canonical(x)}`;
      })
      .join(",")}}`;
  }
  return err("event_invalid", "事件内容必须是有效 JSON");
}
function version(db: DatabaseSync): number {
  return Number(
    db.prepare("SELECT COALESCE(MAX(version),0) v FROM schema_migrations").get()
      ?.v,
  );
}
export function migrateEventCore(
  db: DatabaseSync,
  onStage?: (stage: string) => void,
): void {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
    throw new Error("event migration requires SQLite foreign keys");
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
    throw new Error("event migration requires generation 2");
  if (version(db) > 10)
    err(
      "database_schema_too_new",
      "Database schema is newer than this TaskCircuit binary supports. Upgrade TaskCircuit before opening this database.",
      409,
    );
  if (
    version(db) === 7 ||
    version(db) === 8 ||
    version(db) === 9 ||
    version(db) === 10
  ) {
    for (const name of [
      "event_deliveries",
      "event_delivery_conflicts",
      "event_delivery_history",
      "event_root_links",
    ])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name=?",
          )
          .get(name)
      )
        throw new Error("event schema 7 is incomplete");
    const idx = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='index' AND name='active_correlation_root'",
      )
      .get();
    if (!idx || !String(idx.sql).toUpperCase().includes("CREATE UNIQUE INDEX"))
      throw new Error("event schema 7 correlation index is missing");
    for (const name of [
      "event_core_immutable",
      "delivery_identity_immutable",
      "event_link_definition_unique",
      "event_link_no_delete",
    ])
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?",
          )
          .get(name)
      )
        throw new Error("event schema 7 integrity trigger is missing");
    if (
      !db
        .prepare("PRAGMA table_info(events)")
        .all()
        .some((c) => c.name === "schema_version")
    )
      throw new Error("event schema 7 event columns are missing");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("event schema 7 foreign key check failed");
    return;
  }
  if (version(db) !== 6) throw new Error("event migration requires schema 6");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      version(db) === 7 ||
      version(db) === 8 ||
      version(db) === 9 ||
      version(db) === 10
    ) {
      db.exec("COMMIT");
      return;
    }
    if (version(db) !== 6) throw new Error("event migration requires schema 6");
    db.exec(`ALTER TABLE events ADD COLUMN schema_version INTEGER;
      ALTER TABLE events ADD COLUMN received_at TEXT;
      ALTER TABLE events ADD COLUMN occurred_at TEXT;
      ALTER TABLE events ADD COLUMN payload_digest TEXT;
      ALTER TABLE events ADD COLUMN source_instance TEXT;
      ALTER TABLE events ADD COLUMN parent_event_id TEXT REFERENCES events(id);
      ALTER TABLE events ADD COLUMN trust_context TEXT;
      ALTER TABLE events ADD COLUMN correlation_key TEXT;`);
    onStage?.("event-altered");
    db.exec(`CREATE TABLE event_deliveries(id TEXT PRIMARY KEY,source_instance TEXT NOT NULL,source_event_id TEXT NOT NULL,content_digest TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),status TEXT NOT NULL CHECK(status IN ('received','validated','deduplicated','correlated','routed','processed','rejected','duplicate','unroutable','failed')),received_at TEXT NOT NULL,UNIQUE(source_instance,source_event_id));
      CREATE TABLE event_delivery_conflicts(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES event_deliveries(id),content_digest TEXT NOT NULL,observed_at TEXT NOT NULL);
      CREATE TABLE event_delivery_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT,delivery_id TEXT NOT NULL REFERENCES event_deliveries(id),state TEXT NOT NULL CHECK(state IN ('received','validated','deduplicated','correlated','routed','processed','rejected','duplicate','unroutable','failed')),recorded_at TEXT NOT NULL);
      CREATE INDEX event_history_delivery ON event_delivery_history(delivery_id,sequence);`);
    onStage?.("delivery-created");
    db.exec(`CREATE TABLE event_root_links(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL REFERENCES events(id),root_id TEXT NOT NULL REFERENCES automation_roots(id),relationship TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(event_id,root_id));
      CREATE INDEX event_links_root ON event_root_links(root_id,sequence);
      CREATE INDEX event_parent ON events(parent_event_id);
      CREATE INDEX event_received ON events(received_at,id);
      CREATE UNIQUE INDEX active_correlation_root ON automation_roots(definition_id,definition_version,subject_scope,subject_key) WHERE mode='automation' AND subject_scope IS NOT NULL AND subject_key IS NOT NULL AND status IN ('created','active','waiting','blocked');
      CREATE TRIGGER event_core_immutable BEFORE UPDATE OF id,source,type,payload,created_at,schema_version,received_at,occurred_at,payload_digest,source_instance,parent_event_id,trust_context,correlation_key ON events WHEN OLD.schema_version IS NOT NULL BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_core_no_delete BEFORE DELETE ON events WHEN OLD.schema_version IS NOT NULL BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER delivery_identity_immutable BEFORE UPDATE OF source_instance,source_event_id,content_digest,event_id ON event_deliveries BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER delivery_no_delete BEFORE DELETE ON event_deliveries BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_link_definition_unique BEFORE INSERT ON event_root_links WHEN EXISTS(SELECT 1 FROM event_root_links l JOIN automation_roots old ON old.id=l.root_id JOIN automation_roots candidate ON candidate.id=NEW.root_id WHERE l.event_id=NEW.event_id AND old.definition_id=candidate.definition_id) BEGIN SELECT RAISE(ABORT,'event_definition_conflict'); END;
      CREATE TRIGGER event_link_no_update BEFORE UPDATE ON event_root_links BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_link_no_delete BEFORE DELETE ON event_root_links BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_history_no_update BEFORE UPDATE ON event_delivery_history BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_history_no_delete BEFORE DELETE ON event_delivery_history BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_conflict_no_update BEFORE UPDATE ON event_delivery_conflicts BEGIN SELECT RAISE(ABORT,'event_immutable'); END;
      CREATE TRIGGER event_conflict_no_delete BEFORE DELETE ON event_delivery_conflicts BEGIN SELECT RAISE(ABORT,'event_immutable'); END;`);
    onStage?.("indexes-created");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("event migration foreign key check failed");
    onStage?.("before-schema-update");
    db.prepare("INSERT INTO schema_migrations VALUES(7,?)").run(
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function ingestEvent(
  db: DatabaseSync,
  source: TrustedSource,
  e: EventEnvelope,
  options: EventOptions,
): EventResult {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1)
    throw new Error("event ingestion requires SQLite foreign keys");
  if (
    !identity(source.sourceInstance) ||
    secretValue.test(source.sourceInstance) ||
    ![
      "trusted_local_cli",
      "trusted_internal",
      "external_untrusted",
      "agent_feedback",
    ].includes(source.trustContext)
  )
    err("event_source_invalid", "事件来源不正确");
  if (
    !e ||
    !identity(e.sourceEventId) ||
    secretValue.test(e.sourceEventId) ||
    !identity(e.type, 128) ||
    !eventType.test(e.type)
  )
    err("event_invalid", "事件标识或类型不正确");
  if (e.automationId !== undefined && !identity(e.automationId))
    err("event_invalid", "自动化标识不正确");
  if (
    e.automationIds !== undefined &&
    (!Array.isArray(e.automationIds) ||
      e.automationIds.length === 0 ||
      e.automationIds.length > 32 ||
      e.automationIds.some((x) => !identity(x)) ||
      new Set(e.automationIds).size !== e.automationIds.length ||
      e.automationId !== undefined)
  )
    err("event_invalid", "自动化列表不正确");
  if (
    source.originRootId !== undefined &&
    (source.trustContext !== "trusted_internal" ||
      !identity(source.originRootId) ||
      secretValue.test(source.originRootId) ||
      !e.parentEventId)
  )
    err("event_parent_invalid", "父事件来源不正确");
  const automationIds = e.automationIds
    ? [...e.automationIds].sort()
    : e.automationId
      ? [e.automationId]
      : [];
  if (
    e.correlationKey !== undefined &&
    (!identity(e.correlationKey, 512) ||
      secretValue.test(e.correlationKey) ||
      /(?:^sk-|^ghp_|^github_pat_)/i.test(e.correlationKey))
  )
    err("event_correlation_invalid", "关联键不正确");
  if (
    e.displaySource !== undefined &&
    (!identity(e.displaySource) || secretValue.test(e.displaySource))
  )
    err("event_source_invalid", "显示来源不正确");
  if (
    e.occurredAt !== undefined &&
    (typeof e.occurredAt !== "string" ||
      !Number.isFinite(Date.parse(e.occurredAt)))
  )
    err("event_invalid", "事件发生时间不正确");
  if (
    e.parentEventId !== undefined &&
    (!identity(e.parentEventId) || source.trustContext !== "trusted_internal")
  )
    err("event_parent_invalid", "不允许使用该父事件");
  let payload: string;
  try {
    payload = canonical(e.payload);
  } catch (x) {
    if (x instanceof TaskCircuitError) throw x;
    return err("event_invalid", "事件内容必须是有效 JSON");
  }
  if (Buffer.byteLength(payload, "utf8") > EVENT_PAYLOAD_LIMIT)
    err("event_too_large", "事件内容超过 65536 字节", 413);
  const digest = createHash("sha256")
    .update(
      canonical({
        type: e.type,
        trustContext: source.trustContext,
        originRootId: source.originRootId ?? null,
        payload: JSON.parse(payload),
        automationIds,
        correlationKey: e.correlationKey ?? null,
        occurredAt: e.occurredAt ?? null,
        parentEventId: e.parentEventId ?? null,
        displaySource: e.displaySource ?? null,
      }),
    )
    .digest("hex");
  const time = new Date(options.now()).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const old = db
      .prepare(
        "SELECT * FROM event_deliveries WHERE source_instance=? AND source_event_id=?",
      )
      .get(source.sourceInstance, e.sourceEventId);
    if (old) {
      const links = db
        .prepare(
          "SELECT l.root_id,l.relationship,r.predecessor_root_id FROM event_root_links l JOIN automation_roots r ON r.id=l.root_id WHERE l.event_id=? ORDER BY l.sequence",
        )
        .all(String(old.event_id));
      const roots = links.map((link) => ({
        rootId: String(link.root_id),
        createdRoot: link.relationship === "created",
        predecessorRootId: link.predecessor_root_id
          ? String(link.predecessor_root_id)
          : null,
      }));
      const common = {
        eventId: String(old.event_id),
        rootId: roots[0]?.rootId ?? null,
        createdRoot: roots[0]?.createdRoot ?? false,
        predecessorRootId: roots[0]?.predecessorRootId ?? null,
        receivedAt: String(old.received_at),
        roots,
      };
      if (old.content_digest !== digest) {
        db.prepare("INSERT INTO event_delivery_conflicts VALUES(?,?,?,?)").run(
          randomUUID(),
          String(old.id),
          digest,
          time,
        );
        db.exec("COMMIT");
        return { status: "conflict", ...common };
      }
      db.prepare(
        "INSERT INTO event_delivery_history(delivery_id,state,recorded_at) VALUES(?,'duplicate',?)",
      ).run(String(old.id), time);
      db.exec("COMMIT");
      return { status: "duplicate", ...common };
    }
    const definitions = automationIds.map((id) => {
      const definition = db
        .prepare(
          "SELECT id,current_version FROM automation_definitions WHERE id=? AND id<>'system/manual' AND status='enabled'",
        )
        .get(id);
      if (!definition)
        return err("event_automation_not_found", "自动化不存在或未启用", 404);
      return definition;
    });
    const roots: Array<{
      rootId: string;
      createdRoot: boolean;
      predecessorRootId: string | null;
    }> = [];
    if (e.parentEventId) {
      const parent = db
        .prepare("SELECT id FROM events WHERE id=?")
        .get(e.parentEventId);
      const links = db
        .prepare(
          "SELECT root_id FROM event_root_links WHERE event_id=? ORDER BY sequence",
        )
        .all(e.parentEventId);
      if (!parent || links.length === 0)
        err("event_parent_invalid", "父事件不存在或没有 Root");
      const selected = source.originRootId
        ? links.find((link) => link.root_id === source.originRootId)
        : links.length === 1
          ? links[0]
          : undefined;
      if (!selected)
        return err(
          "event_parent_invalid",
          "父事件关联不唯一或来源 Root 不匹配",
        );
      const parentRoot = db
        .prepare("SELECT * FROM automation_roots WHERE id=?")
        .get(String(selected.root_id));
      if (
        !parentRoot ||
        !["created", "active", "waiting", "blocked"].includes(
          String(parentRoot.status),
        )
      )
        return err("event_parent_invalid", "父事件 Root 不可继续");
      if (
        automationIds.length &&
        (automationIds.length !== 1 ||
          automationIds[0] !== parentRoot.definition_id)
      )
        err("event_parent_invalid", "父事件自动化不匹配");
      if (
        e.correlationKey !== undefined &&
        e.correlationKey !== parentRoot.subject_key
      )
        err("event_parent_invalid", "父事件关联键不匹配");
      if (options.knownTypes.has(e.type))
        roots.push({
          rootId: String(parentRoot.id),
          createdRoot: false,
          predecessorRootId: parentRoot.predecessor_root_id
            ? String(parentRoot.predecessor_root_id)
            : null,
        });
    } else if (options.knownTypes.has(e.type)) {
      for (const definition of definitions) {
        const versionNum = Number(definition.current_version);
        let rootId: string | null = null,
          predecessorRootId: string | null = null,
          createdRoot = false;
        if (e.correlationKey !== undefined) {
          const active = db
            .prepare(
              "SELECT id FROM automation_roots WHERE definition_id=? AND definition_version=? AND mode='automation' AND subject_scope=? AND subject_key=? AND status IN ('created','active','waiting','blocked') ORDER BY created_at,id",
            )
            .all(
              String(definition.id),
              versionNum,
              source.sourceInstance,
              e.correlationKey,
            );
          if (active.length > 1)
            err("event_correlation_conflict", "存在多个活动 Root", 409);
          if (active.length === 1) rootId = String(active[0].id);
          else {
            const last = db
              .prepare(
                "SELECT id FROM automation_roots WHERE definition_id=? AND definition_version=? AND mode='automation' AND subject_scope=? AND subject_key=? AND status IN ('completed','failed','cancelled','expired','budget_exhausted') ORDER BY rowid DESC LIMIT 1",
              )
              .get(
                String(definition.id),
                versionNum,
                source.sourceInstance,
                e.correlationKey,
              );
            if (last) predecessorRootId = String(last.id);
          }
        }
        if (!rootId) {
          rootId = randomUUID();
          createdRoot = true;
          const configured = db
            .prepare("PRAGMA table_info(automation_roots)")
            .all()
            .some((x) => x.name === "max_runs");
          const snapshot = configured
            ? db
                .prepare(
                  "SELECT config_snapshot_json FROM automation_definition_versions WHERE definition_id=? AND version=?",
                )
                .get(String(definition.id), versionNum)
            : undefined;
          const limits = snapshot
            ? frozenLoop(
                JSON.parse(String(snapshot.config_snapshot_json)),
                time,
              )
            : undefined;
          db.prepare(
            configured
              ? "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,subject_scope,subject_key,predecessor_root_id,created_at,updated_at,max_runs,deadline_at) VALUES(?,?,?,'automation','created',?,?,?,?,?,?,?)"
              : "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,subject_scope,subject_key,predecessor_root_id,created_at,updated_at) VALUES(?,?,?,'automation','created',?,?,?,?,?)",
          ).run(
            rootId,
            String(definition.id),
            versionNum,
            e.correlationKey === undefined ? null : source.sourceInstance,
            e.correlationKey ?? null,
            predecessorRootId,
            time,
            time,
            ...(limits ? [limits.maxRuns, limits.deadlineAt] : []),
          );
          options.onStage?.("root-created");
        }
        roots.push({ rootId, createdRoot, predecessorRootId });
      }
    }
    const rootId = roots[0]?.rootId ?? null;
    const createdRoot = roots[0]?.createdRoot ?? false;
    const predecessorRootId = roots[0]?.predecessorRootId ?? null;
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    const status = rootId ? "accepted" : "unroutable";
    db.prepare(
      "INSERT INTO events(id,source,type,payload,created_at,schema_version,received_at,occurred_at,payload_digest,source_instance,parent_event_id,trust_context,correlation_key) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?)",
    ).run(
      eventId,
      e.displaySource ?? source.sourceInstance,
      e.type,
      payload,
      time,
      time,
      e.occurredAt ?? null,
      createHash("sha256").update(payload).digest("hex"),
      source.sourceInstance,
      e.parentEventId ?? null,
      source.trustContext,
      e.correlationKey ?? null,
    );
    options.onStage?.("event-inserted");
    db.prepare("INSERT INTO event_deliveries VALUES(?,?,?,?,?,?,?)").run(
      deliveryId,
      source.sourceInstance,
      e.sourceEventId,
      digest,
      eventId,
      rootId ? "processed" : "unroutable",
      time,
    );
    options.onStage?.("delivery-inserted");
    const history = db.prepare(
      "INSERT INTO event_delivery_history(delivery_id,state,recorded_at) VALUES(?,?,?)",
    );
    for (const state of [
      "received",
      "validated",
      "deduplicated",
      ...(rootId ? ["correlated", "routed", "processed"] : ["unroutable"]),
    ])
      history.run(deliveryId, state, time);
    const linkStatement = db.prepare(
      "INSERT INTO event_root_links(event_id,root_id,relationship,created_at) VALUES(?,?,?,?)",
    );
    for (const root of roots)
      linkStatement.run(
        eventId,
        root.rootId,
        e.parentEventId
          ? "inherited"
          : root.createdRoot
            ? "created"
            : "correlated",
        time,
      );
    db.exec("COMMIT");
    return {
      status,
      eventId,
      rootId,
      createdRoot,
      predecessorRootId,
      receivedAt: time,
      roots,
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
