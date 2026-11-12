import Fastify from "fastify";
import { existsSync, realpathSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  resultDigest,
  validDigest,
  validSubmissionId,
} from "./result-receipt.js";
import { migrate } from "./migration.js";
import { migrateDomain, createDefinition } from "./automation-domain.js";
import { loopConfig } from "./loop-limits.js";
import { migrateLoopLimits } from "./loop-limits.js";
import {
  claimCandidateSql,
  inspectAdmission,
  terminateForLimit,
  recoverContinuations,
  expireQueuedAutomations,
} from "./execution-admission.js";
import {
  migrateMaterialization,
  materializeDecision,
  processPendingMaterializations,
} from "./decision-materialization.js";
import {
  migrateDecisionCore,
  evaluateDecision,
  getDecision,
  listRootDecisions,
  processPendingDecisions,
} from "./decision-core.js";
import { migrateEventCore, ingestEvent } from "./event-core.js";
import { createHubPluginRegistry } from "./plugins/builtin/sources.js";
import type { PluginRegistry } from "./plugins/registry.js";
import { validateSources, type Config } from "./config.js";
import { ActiveSources, bindActiveSources } from "./plugins/active-sources.js";
import { isActiveSource } from "./plugins/types.js";
import { IntegrationIngress } from "./integrations/ingress.js";
import { TaskCircuitError } from "./domain.js";
import { applyDocument } from "./declarative.js";
import { type HubOptions } from "./notifications.js";
import { bindChannels } from "./plugins/channel-host.js";
import {
  nextCron,
  retryDelay,
  validPolicy,
  validInstant,
  systemClock,
  type Clock,
} from "./scheduling.js";

type Row = Record<string, unknown>;
const object = (x: unknown): x is Row =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const json = (x: unknown) => JSON.stringify(x ?? null);
const shape = (r: Row | undefined): Row | null => {
  if (!r) return null;
  const keys = new Set([
    "input",
    "output",
    "error",
    "payload",
    "request",
    "response",
    "metadata",
    "config",
  ]);
  return Object.fromEntries(
    Object.entries(r)
      .filter(([k]) => k !== "lease_token")
      .map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        keys.has(k) && typeof v === "string" ? JSON.parse(v) : v,
      ]),
  );
};
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
export function createHub(
  path: string,
  config: Config,
  clock: (() => number) | Clock = systemClock,
  pollIntervalMs = 1000,
  options: HubOptions = {},
  pluginBinding: { registry: PluginRegistry; sourceId: string } = {
    registry: createHubPluginRegistry(),
    sourceId: "local",
  },
) {
  validateSources(config);
  const sourcePlugin = pluginBinding.registry.getSource(pluginBinding.sourceId);
  if (isActiveSource(sourcePlugin))
    throw new Error("legacy_source_requires_api_1");
  const sourceBindings = bindActiveSources(
    pluginBinding.registry,
    config.sources,
  );
  const needsIngress = sourceBindings.some(
    ({ plugin }) => plugin.http === true,
  );
  if (needsIngress && !config.integrationIngress)
    throw new Error("integration_ingress_required");
  if (
    needsIngress &&
    options.managementPort === config.integrationIngress?.port
  )
    throw new Error("integration_ingress_port_collision");
  const ingress =
    needsIngress && config.integrationIngress
      ? new IntegrationIngress(config.integrationIngress)
      : undefined;
  for (const { id, plugin } of sourceBindings)
    if (plugin.http === true) ingress?.reserve(plugin.manifest.id, id);

  const clockNow = typeof clock === "function" ? clock : () => clock.now();
  if (path !== ":memory:" && !existsSync(path))
    throw new TaskCircuitError(
      "storage_generation_required",
      "请先完成存储代际切换。",
      409,
    );
  const db = new DatabaseSync(path);
  let channelHost: ReturnType<typeof bindChannels>;
  try {
    if (path === ":memory:") {
      db.exec("PRAGMA foreign_keys=ON");
      migrate(db);
      db.exec(
        "CREATE TABLE taskcircuit_generation(migration_id TEXT NOT NULL,generation INTEGER NOT NULL); INSERT INTO taskcircuit_generation VALUES('memory',2); INSERT INTO schema_migrations VALUES(5,'1970-01-01T00:00:00.000Z')",
      );
    } else {
      const generation = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='taskcircuit_generation'",
        )
        .get();
      if (!generation)
        throw new TaskCircuitError(
          "storage_generation_required",
          "请先完成存储代际切换。",
          409,
        );
    }
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    migrate(db);
    migrateDomain(db);
    migrateEventCore(db);
    migrateDecisionCore(db);
    migrateMaterialization(db);
    migrateLoopLimits(db);
    channelHost = bindChannels(
      pluginBinding.registry,
      config.channels,
      options.channels,
    );
  } catch (error) {
    db.close();
    throw error;
  }
  const { channels, stop: stopChannels } = channelHost;
  const hub = Fastify({ logger: false });
  const run = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).run(...args);
  const get = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args) as Row[];
  const activeSources = new ActiveSources(
    sourceBindings,
    (sourceInstance, input) => {
      db.exec("PRAGMA busy_timeout=250");
      try {
        const trustContext = "external_untrusted";
        // Reuse the first routing decision when checking a redelivery.
        const previous = get(
          "SELECT r.definition_id FROM event_deliveries d LEFT JOIN event_root_links l ON l.event_id=d.event_id LEFT JOIN automation_roots r ON r.id=l.root_id WHERE d.source_instance=? AND d.source_event_id=?",
          sourceInstance,
          typeof input.sourceEventId === "string" ? input.sourceEventId : "",
        );
        let automationId =
          typeof previous?.definition_id === "string"
            ? previous.definition_id
            : undefined;
        if (!previous) {
          const route = config.routes.find(
            (candidate) =>
              candidate.event.source === sourceInstance &&
              candidate.event.type === input.type,
          );
          if (!route)
            throw new TaskCircuitError(
              "source_event_type_unconfigured",
              "来源未配置该事件类型",
              400,
            );
          automationId = route.automationId;
          if (automationId) {
            const version = get(
              "SELECT v.config_snapshot_json FROM automation_definitions d JOIN automation_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version WHERE d.id=? AND d.status='enabled'",
              automationId,
            );
            const snapshot: unknown = version
              ? JSON.parse(String(version.config_snapshot_json))
              : null;
            const policy = object(snapshot) ? snapshot.policy : null;
            if (
              !object(policy) ||
              policy.sourceInstance !== sourceInstance ||
              policy.sourceTrustContext !== trustContext ||
              policy.agentProfileId !== route.agent ||
              !Array.isArray(policy.eventTypes) ||
              !policy.eventTypes.includes(input.type)
            )
              throw new TaskCircuitError(
                "source_route_unavailable",
                "来源路由尚未就绪",
                503,
              );
          }
        }
        const { status, eventId } = ingestEvent(
          db,
          { sourceInstance, trustContext },
          { ...input, ...(automationId ? { automationId } : {}) },
          { knownTypes: new Set([input.type]), now: clockNow },
        );
        return { status, eventId };
      } catch (error) {
        if (
          error instanceof Error &&
          "errcode" in error &&
          typeof error.errcode === "number" &&
          [5, 6].includes(error.errcode & 255)
        )
          throw new TaskCircuitError("source_intake_busy", "来源接收繁忙", 503);
        throw error;
      } finally {
        db.exec("PRAGMA busy_timeout=5000");
      }
    },
    ingress,
  );
  let stoppingSources: Promise<void> | undefined;
  const stopSources = () =>
    (stoppingSources ??= (async () => {
      await ingress?.drain();
      await activeSources.close();
      await ingress?.close();
    })());
  const rootSummary = (id: string): Row | null => {
    const root = get(
      `SELECT r.id,r.status,r.terminal_reason,r.created_at,r.deadline_at,r.max_runs,d.name automation FROM automation_roots r JOIN automation_definitions d ON d.id=r.definition_id WHERE r.id=?`,
      id,
    );
    if (!root) return null;
    const work = get(
      `SELECT id,status,agent_profile_id FROM work_items WHERE root_id=? ORDER BY created_at DESC LIMIT 1`,
      id,
    );
    const execution = work
      ? get(
          `SELECT status,output,error FROM executions WHERE work_item_id=? ORDER BY sequence DESC LIMIT 1`,
          String(work.id),
        )
      : undefined;
    const runs = get(
      `SELECT count(*) AS n FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE w.root_id=? AND e.started_at IS NOT NULL`,
      id,
    );
    const schedule = work
      ? get(
          `SELECT next_fire_at FROM schedules WHERE owner_kind='work_item' AND owner_id=? AND status='active' ORDER BY next_fire_at LIMIT 1`,
          String(work.id),
        )
      : undefined;
    let feedback: unknown = null;
    let errorCode: unknown = null;
    try {
      if (typeof execution?.output === "string") {
        const value: unknown = JSON.parse(execution.output);
        if (object(value) && typeof value.feedback === "string")
          feedback = value.feedback;
      }
    } catch {}
    try {
      if (typeof execution?.error === "string") {
        const value: unknown = JSON.parse(execution.error);
        if (object(value) && typeof value.code === "string")
          errorCode = value.code;
      }
    } catch {}
    return {
      id: root.id,
      automation: root.automation,
      status: root.status,
      reason: root.terminal_reason,
      started: root.created_at,
      deadline: root.deadline_at,
      maxRuns: root.max_runs,
      runs: runs?.n ?? 0,
      agent: work?.agent_profile_id ?? null,
      waiting: work?.status ?? null,
      nextRun: schedule?.next_fire_at ?? null,
      latestFeedback: feedback,
      errorCode,
    };
  };
  hub.get("/api/roots", async () =>
    all(
      "SELECT id FROM automation_roots ORDER BY created_at DESC LIMIT 100",
    ).map((r) => rootSummary(String(r.id))),
  );
  hub.get<{ Params: { id: string } }>(
    "/api/roots/:id",
    async (req, reply) =>
      rootSummary(req.params.id) ??
      reply.code(404).send({ error: "Root not found" }),
  );
  const now = () => new Date(clockNow()).toISOString();
  const expiry = () => new Date(clockNow() + 30000).toISOString();
  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const createNotification = (
    workId: string,
    interactionId: string | null,
    kind: "interaction_required" | "work_item_failed" | "work_item_completed",
    title: string,
    time: string,
    errorCode?: string,
  ) => {
    const work = get("SELECT metadata FROM work_items WHERE id=?", workId);
    if (!work) return;
    const metadata = JSON.parse(String(work.metadata)) as Row;
    const notify = Array.isArray(metadata.notify)
      ? metadata.notify.filter(str)
      : Object.keys(channels);
    if (kind === "work_item_completed" && metadata.notifyOnCompleted !== true)
      return;
    const id = randomUUID();
    const severity =
      kind === "interaction_required"
        ? "attention"
        : kind === "work_item_failed"
          ? "error"
          : "info";
    const errorLabels: Record<string, string> = {
      quota_exceeded: "Agent failed: quota exceeded",
      rate_limited: "Agent failed: rate limited",
      auth_failed: "Agent failed: authentication required",
      agent_unavailable: "Agent failed: CLI unavailable",
      agent_timeout: "Agent failed: timed out",
      agent_protocol: "Agent failed: invalid response",
      execution_outcome_unknown:
        "执行结果需要核实；Agent 可能已经执行了外部操作，系统不会自动重新执行。",
    };
    const body =
      kind === "interaction_required"
        ? "有问题需要回答"
        : kind === "work_item_failed"
          ? (errorCode &&
              Object.hasOwn(errorLabels, errorCode) &&
              errorLabels[errorCode]) ||
            "工作执行失败"
          : "工作已完成";
    run(
      "INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      id,
      kind,
      severity,
      workId,
      interactionId,
      title,
      body,
      "open",
      time,
      null,
      `${kind}:${interactionId ?? workId}`,
    );
    for (const channelId of notify)
      run(
        "INSERT INTO notification_deliveries(id,notification_id,channel_id,status,attempt,not_before,created_at) VALUES(?,?,?,?,?,?,?)",
        randomUUID(),
        id,
        channelId,
        "queued",
        0,
        time,
        time,
      );
  };
  const resolveNotifications = (where: string, id: string, time: string) => {
    const records = all(
      `SELECT id FROM notifications WHERE ${where}=? AND status='open'`,
      id,
    );
    for (const row of records) {
      run(
        "UPDATE notifications SET status='resolved',resolved_at=? WHERE id=?",
        time,
        String(row.id),
      );
      run(
        "UPDATE notification_deliveries SET status='cancelled',lease_token=NULL WHERE notification_id=? AND status IN ('queued','claimed')",
        String(row.id),
      );
    }
  };
  const readChanges = (after: number, limit = 200) =>
    all(
      "SELECT * FROM runtime_changes WHERE sequence>? ORDER BY sequence LIMIT ?",
      after,
      limit,
    ).map(shape);
  const streamHead = () =>
    Number(
      get("SELECT seq FROM sqlite_sequence WHERE name='runtime_changes'")
        ?.seq ?? 0,
    );
  const pruneChanges = (maxChanges = 10000) =>
    tx(() => {
      if (!Number.isSafeInteger(maxChanges) || maxChanges < 1)
        throw new Error("保留条数不正确");
      const cutoff = get(
        "SELECT sequence FROM runtime_changes ORDER BY sequence DESC LIMIT 1 OFFSET ?",
        maxChanges,
      );
      if (!cutoff) return 0;
      const sequence = Number(cutoff.sequence);
      const deleted = Number(
        run("DELETE FROM runtime_changes WHERE sequence<=?", sequence).changes,
      );
      run(
        "UPDATE stream_retention SET pruned_through=MAX(pruned_through,?) WHERE id=1",
        sequence,
      );
      return deleted;
    });
  const inbox = () =>
    all(
      "SELECT i.id AS interaction_id,i.work_item_id,w.title AS work_title,i.request,i.created_at FROM interactions i JOIN work_items w ON w.id=i.work_item_id WHERE i.status='open' ORDER BY i.created_at,i.id LIMIT 100",
    ).map(shape);
  let dispatching: Promise<void> | undefined;
  const dispatchNotifications = (): Promise<void> => {
    if (channelHost.signal.aborted) return Promise.resolve();
    if (dispatching) return dispatching;
    dispatching = (async () => {
      const claimed = tx(() => {
        const time = now();
        run(
          "UPDATE notification_deliveries SET status='failed',lease_token=NULL,last_error='投递租约已过期' WHERE status='claimed' AND lease_expires_at<=? AND attempt>=3",
          time,
        );
        const row = get(
          "SELECT d.*,n.kind,n.severity,n.work_item_id,n.interaction_id,n.title,n.body FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.status='open' AND ((d.status='queued' AND d.not_before<=?) OR (d.status='claimed' AND d.lease_expires_at<=?)) ORDER BY d.created_at,d.id LIMIT 1",
          time,
          time,
        );
        if (!row) return null;
        const token = randomUUID();
        run(
          "UPDATE notification_deliveries SET status='claimed',attempt=attempt+1,claimed_by=?,lease_token=?,lease_expires_at=? WHERE id=?",
          "dispatcher",
          token,
          new Date(clockNow() + 30000).toISOString(),
          String(row.id),
        );
        return { row, token };
      });
      if (!claimed) return;
      const { row, token } = claimed;
      try {
        const channel = channels[String(row.channel_id)];
        if (!channel) throw new Error("channel unavailable");
        const result = await channel.deliver({
          deliveryId: String(row.id),
          notificationId: String(row.notification_id),
          kind: String(row.kind),
          severity: String(row.severity),
          workItemId: String(row.work_item_id),
          interactionId:
            row.interaction_id === null ? null : String(row.interaction_id),
          title: String(row.title),
          body: String(row.body),
        });
        if (!result.ok) throw new Error("delivery failed");
        tx(() => {
          run(
            "UPDATE notification_deliveries SET status='sent',sent_at=?,lease_token=NULL WHERE id=? AND status='claimed' AND lease_token=? AND lease_expires_at>?",
            now(),
            String(row.id),
            token,
            now(),
          );
        });
      } catch {
        tx(() => {
          const current = get(
            "SELECT attempt FROM notification_deliveries WHERE id=? AND status='claimed' AND lease_token=? AND lease_expires_at>?",
            String(row.id),
            token,
            now(),
          );
          if (!current) return;
          const exhausted = Number(current.attempt) >= 3;
          run(
            "UPDATE notification_deliveries SET status=?,not_before=?,last_error=?,lease_token=NULL WHERE id=?",
            exhausted ? "failed" : "queued",
            new Date(clockNow() + 5000).toISOString(),
            "投递失败",
            String(row.id),
          );
        });
      }
    })().finally(() => {
      dispatching = undefined;
    });
    return dispatching;
  };
  const streams = new Set<() => void>();
  Object.assign(hub, {
    readChanges,
    pruneChanges,
    dispatchNotifications,
    getStreamCount: () => streams.size,
  });
  hub.get("/api/stream/head", async () => ({ sequence: streamHead() }));
  hub.get("/api/inbox", async () => inbox());
  hub.get("/api/notifications", async () =>
    all("SELECT * FROM notifications ORDER BY created_at,id").map((n) => ({
      ...shape(n),
      deliveries: all(
        "SELECT * FROM notification_deliveries WHERE notification_id=? ORDER BY created_at,id",
        String(n.id),
      ).map(shape),
    })),
  );
  hub.get("/api/state", async () => ({
    recentWorkItems: all(
      "SELECT id,title,status,created_at,updated_at FROM work_items ORDER BY updated_at DESC LIMIT 50",
    ).map(shape),
    activeWorkItems: all(
      "SELECT id,title,status,created_at,updated_at FROM work_items WHERE status IN ('active','waiting_input','waiting_schedule') ORDER BY updated_at DESC LIMIT 50",
    ).map(shape),
    inbox: inbox(),
    activeSchedules: all(
      "SELECT id,kind,status,owner_kind,owner_id,reason,expression,timezone,next_fire_at,last_fire_at FROM schedules WHERE status='active' ORDER BY next_fire_at LIMIT 50",
    ).map(shape),
    sequence: streamHead(),
  }));
  hub.get<{ Querystring: { after?: string } }>(
    "/api/stream",
    async (req, reply) => {
      const raw = req.query.after ?? req.headers["last-event-id"] ?? "0";
      if (
        typeof raw !== "string" ||
        !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(Number(raw))
      )
        return reply.code(400).send({ error: "invalid_stream_cursor" });
      let cursor = Number(raw);
      const pruned = Number(
        get("SELECT pruned_through FROM stream_retention WHERE id=1")
          ?.pruned_through ?? 0,
      );
      if (cursor < pruned) {
        const oldest = get(
          "SELECT MIN(sequence) AS sequence FROM runtime_changes",
        );
        return reply.code(409).send({
          error: "stream_cursor_expired",
          oldestAvailableSequence: oldest?.sequence ?? null,
        });
      }
      reply.hijack();
      const response = reply.raw;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      let blocked = false;
      let closed = false;
      const pump = () => {
        if (blocked || closed) return;
        try {
          const boundary = Number(
            get("SELECT pruned_through FROM stream_retention WHERE id=1")
              ?.pruned_through ?? 0,
          );
          if (cursor < boundary) {
            response.write(
              'event: resync\ndata: {"error":"stream_cursor_expired"}\n\n',
            );
            response.end();
            return;
          }
          for (const item of readChanges(cursor)) {
            if (!item) continue;
            cursor = Number(item.sequence);
            if (
              !response.write(
                `id: ${cursor}\nevent: change\ndata: ${JSON.stringify(item)}\n\n`,
              )
            ) {
              blocked = true;
              break;
            }
          }
        } catch {
          response.destroy();
        }
      };
      const onDrain = () => {
        blocked = false;
        pump();
      };
      response.on("drain", onDrain);
      const poll = setInterval(pump, options.streamPollMs ?? 100);
      const heartbeat = setInterval(() => {
        if (!blocked && !closed && !response.write(": ping\n\n"))
          blocked = true;
      }, options.streamHeartbeatMs ?? 15000);
      poll.unref();
      heartbeat.unref();
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll);
        clearInterval(heartbeat);
        response.off("drain", onDrain);
        streams.delete(cleanup);
        if (!response.destroyed && !response.writableEnded) response.end();
      };
      streams.add(cleanup);
      response.once("close", cleanup);
      pump();
      return reply;
    },
  );
  let dispatcherTimer: ReturnType<typeof setInterval> | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  hub.addHook("onReady", async () => {
    const ms = options.dispatcherPollMs ?? 1000;
    if (ms > 0) {
      dispatcherTimer = setInterval(() => {
        void dispatchNotifications().catch(() =>
          hub.log.error("notification dispatch failed"),
        );
      }, ms);
      dispatcherTimer.unref();
      void dispatchNotifications().catch(() =>
        hub.log.error("notification dispatch failed"),
      );
    }
    pruneChanges();
    maintenanceTimer = setInterval(() => {
      try {
        pruneChanges();
      } catch {
        hub.log.error("stream maintenance failed");
      }
    }, 60000);
    maintenanceTimer.unref();
  });
  hub.addHook("preClose", async () => {
    void stopChannels();
    for (const close of [...streams]) close();
    await stopSources();
  });
  hub.addHook("onClose", async () => {
    if (dispatcherTimer) clearInterval(dispatcherTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    for (const close of streams) close();
    await stopChannels();
    if (dispatching) await dispatching;
  });
  const bad = (message: string): never => {
    throw new TaskCircuitError("invalid_request", message, 400);
  };
  hub.setErrorHandler((error, request, reply) => {
    const e =
      error instanceof TaskCircuitError
        ? error
        : error instanceof Error &&
            "code" in error &&
            error.code === "FST_ERR_CTP_BODY_TOO_LARGE" &&
            request.url.startsWith("/api/events/v2")
          ? new TaskCircuitError("event_too_large", "请求内容过大", 413)
          : new TaskCircuitError("internal_error", "服务处理失败", 500);
    reply.code(e.status).send({ error: { code: e.code, message: e.message } });
  });
  const missing = () => {
    throw new TaskCircuitError("not_found", "没有找到对应记录", 404);
  };
  const automationSummary = (id: string): Row | null => {
    const row = get(
      `SELECT d.id,d.name,d.status,v.config_snapshot_json FROM automation_definitions d JOIN automation_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version WHERE d.id=?`,
      id,
    );
    if (!row) return null;
    const snapshot: unknown = JSON.parse(String(row.config_snapshot_json));
    if (!object(snapshot) || !object(snapshot.policy))
      return { id: row.id, name: row.name, status: row.status };
    const policy = snapshot.policy,
      loop = loopConfig(snapshot);
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      eventType: Array.isArray(policy.eventTypes) ? policy.eventTypes[0] : null,
      agent: policy.agentProfileId,
      workspace: policy.workspacePath,
      ...loop,
    };
  };
  hub.get("/api/automations", async () =>
    all(
      "SELECT id FROM automation_definitions WHERE id<>'system/manual' ORDER BY created_at,id",
    ).map((x) => automationSummary(String(x.id))),
  );
  hub.get<{ Params: { id: string } }>(
    "/api/automations/:id",
    async (req) => automationSummary(req.params.id) ?? missing(),
  );
  hub.post("/api/automations/apply", async (req, reply) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip))
      throw new TaskCircuitError("apply_source_invalid", "仅接受本机连接", 403);
    const body = req.body;
    if (
      !object(body) ||
      Object.keys(body).some((k) => k !== "document" && k !== "dryRun") ||
      typeof body.dryRun !== "boolean"
    )
      throw new TaskCircuitError("apply_invalid", "应用请求无效", 400);
    const plan = applyDocument(
      db,
      config,
      body.document,
      body.dryRun,
      clockNow,
    );
    return plan.summary.invalid ? reply.code(400).send(plan) : plan;
  });
  hub.post("/api/automations", async (req) => {
    const b = req.body;
    if (
      !object(b) ||
      typeof b.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(b.id) ||
      typeof b.eventType !== "string" ||
      typeof b.agent !== "string" ||
      typeof b.workspace !== "string" ||
      (b.instruction !== undefined && typeof b.instruction !== "string")
    )
      return bad("自动化参数不正确");
    const id = b.id,
      eventType = b.eventType,
      agent = b.agent,
      workspace = b.workspace;
    if (
      !config.agents[agent] ||
      !config.routes.some((r) => r.event.type === eventType)
    )
      return bad("Agent 或事件类型未在可信配置中注册");
    let registered:
      [string, NonNullable<Config["policyWorkspaces"]>[string]] | undefined;
    try {
      const canonical = realpathSync(workspace);
      registered = Object.entries(config.policyWorkspaces ?? {}).find(
        ([, w]) => realpathSync(w.path) === canonical,
      );
    } catch {
      return bad("工作目录不存在");
    }
    if (!registered) return bad("工作目录未在可信配置中注册");
    if (get("SELECT id FROM automation_definitions WHERE id=?", id))
      return conflict();
    const [workspaceId, ws] = registered;
    const snapshot = {
      instruction: b.instruction ?? "",
      loop: {
        maxRuns: b.maxRuns ?? 8,
        maxDurationSeconds: b.maxDurationSeconds ?? 7200,
      },
      policy: {
        effect: "authorize",
        eventTypes: [eventType],
        agentProfileId: agent,
        agentProfileSnapshot: config.agents[agent],
        workspaceId,
        workspacePath: ws.path,
        workspaceAllowedRoot: ws.allowedRoot,
        allowedCapabilities: ws.allowedCapabilities,
        requestedCapabilities: ws.allowedCapabilities,
        requiresApproval: false,
      },
    };
    loopConfig(snapshot);
    createDefinition(db, id, id, snapshot, now());
    return automationSummary(id);
  });
  const conflict = () => {
    throw new TaskCircuitError("conflict", "状态或租约已失效", 409);
  };
  const details = (workId: string) => {
    const w = get("SELECT * FROM work_items WHERE id=?", workId);
    if (!w) return missing();
    return {
      workItem: shape(w),
      agentProfile: shape(
        get(
          "SELECT * FROM agent_profiles WHERE id=?",
          String(w.agent_profile_id),
        ),
      ),
      executions: all(
        "SELECT * FROM executions WHERE work_item_id=? ORDER BY sequence",
        workId,
      ).map(shape),
      agentSession: shape(
        get("SELECT * FROM agent_sessions WHERE work_item_id=?", workId),
      ),
      schedules: all(
        "SELECT * FROM schedules WHERE owner_kind='work_item' AND owner_id=? ORDER BY created_at",
        workId,
      ).map(shape),
      interactions: all(
        "SELECT * FROM interactions WHERE work_item_id=? ORDER BY created_at",
        workId,
      ).map(shape),
    };
  };
  hub.post<{ Params: { id: string } }>(
    "/api/workers/:id/heartbeat",
    async (req) => {
      const body = req.body;
      if (
        !object(body) ||
        !["online", "stopped"].includes(String(body.status)) ||
        !str(req.params.id) ||
        req.params.id.length > 200
      )
        return bad("Worker 状态不正确");
      run(
        "INSERT INTO worker_presence(id,status,last_seen_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,last_seen_at=excluded.last_seen_at",
        req.params.id,
        String(body.status),
        now(),
      );
      return { ok: true };
    },
  );
  hub.get("/api/workers", async () =>
    all(
      "SELECT id,status,last_seen_at FROM worker_presence ORDER BY last_seen_at DESC",
    ).map((row) => ({
      ...shape(row),
      state:
        row.status === "stopped"
          ? "stopped"
          : clockNow() - Date.parse(String(row.last_seen_at)) <= 30000
            ? "online"
            : "stale",
    })),
  );
  hub.get("/api/health", async () => ({
    ok: true,
    service: "taskcircuit",
    ...(sourceBindings.length ? { sources: activeSources.health() } : {}),
    ...channelHost.health(),
  }));
  hub.get("/api/diagnostics", async () => ({
    schema: Number(get("SELECT MAX(version) v FROM schema_migrations")?.v),
    agentProfiles: Object.keys(config.agents).sort(),
    ...(ingress
      ? {
          integrationIngress: {
            host: "127.0.0.1",
            port: config.integrationIngress?.port,
          },
        }
      : {}),
  }));
  const scheduleWork = (
    workId: string,
    parentId: string,
    reason: "later" | "retry",
    due: string,
    time: string,
  ) => {
    run(
      "INSERT INTO schedules(id,kind,status,owner_kind,owner_id,reason,parent_execution_id,run_at,next_fire_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      randomUUID(),
      "once",
      "active",
      "work_item",
      workId,
      reason,
      parentId,
      due,
      due,
      time,
      time,
    );
  };
  const parseUserSchedule = (b: Row) => {
    if (
      !["once", "cron"].includes(String(b.kind)) ||
      !object(b.event) ||
      b.event.source !== "local" ||
      !str(b.event.type) ||
      !object(b.event.payload)
    )
      return bad("计划格式不正确");
    const eventValue = b.event as Row;
    if (
      !config.routes.some(
        (r) =>
          r.event.source === eventValue.source &&
          r.event.type === eventValue.type,
      )
    )
      return bad("计划事件没有匹配路由");
    const time = now();
    let due: string;
    let expr: string | null = null;
    let zone: string | null = null;
    if (b.kind === "once") {
      if (!validInstant(b.runAt)) return bad("一次性计划时间不正确");
      due = new Date(b.runAt).toISOString();
    } else {
      if (!str(b.expression) || !(b.timezone === undefined || str(b.timezone)))
        return bad("Cron 配置不正确");
      expr = b.expression;
      zone = (b.timezone as string | undefined) ?? "UTC";
      try {
        due = nextCron(expr, zone, clockNow());
      } catch {
        return bad("Cron 表达式或时区无效");
      }
    }
    const event = b.event as Row;
    const id = randomUUID();
    run(
      "INSERT INTO schedules(id,kind,status,owner_kind,reason,source,event_type,payload,expression,timezone,run_at,next_fire_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      String(b.kind),
      "active",
      "user",
      "event",
      String(event.source),
      String(event.type),
      json(event.payload),
      expr,
      zone,
      b.kind === "once" ? due : null,
      due,
      time,
      time,
    );
    return shape(get("SELECT * FROM schedules WHERE id=?", id));
  };
  hub.get("/api/schedules", async () =>
    all("SELECT * FROM schedules ORDER BY created_at").map(shape),
  );
  hub.post("/api/schedules", async (req) => {
    if (!object(req.body)) return bad("计划格式不正确");
    return tx(() => parseUserSchedule(req.body as Row));
  });
  hub.get<{ Params: { id: string } }>(
    "/api/schedules/:id",
    async (req) =>
      shape(get("SELECT * FROM schedules WHERE id=?", req.params.id)) ??
      missing(),
  );
  for (const action of ["pause", "resume"] as const)
    hub.post<{ Params: { id: string } }>(
      `/api/schedules/:id/${action}`,
      async (req) =>
        tx(() => {
          const s = get("SELECT * FROM schedules WHERE id=?", req.params.id);
          if (!s) return missing();
          if (
            s.owner_kind !== "user" ||
            s.status !== (action === "pause" ? "active" : "paused")
          )
            return conflict();
          run(
            "UPDATE schedules SET status=?,updated_at=? WHERE id=?",
            action === "pause" ? "paused" : "active",
            now(),
            req.params.id,
          );
          return { ok: true };
        }),
    );
  hub.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req) =>
    tx(() => {
      const s = get("SELECT * FROM schedules WHERE id=?", req.params.id);
      if (!s) return missing();
      if (
        s.owner_kind !== "user" ||
        !["active", "paused"].includes(String(s.status))
      )
        return conflict();
      run(
        "UPDATE schedules SET status='cancelled',updated_at=? WHERE id=?",
        now(),
        req.params.id,
      );
      return { ok: true };
    }),
  );
  hub.post<{ Params: { id: string } }>(
    "/api/work-items/:id/cancel",
    async (req) =>
      tx(() => {
        const w = get("SELECT * FROM work_items WHERE id=?", req.params.id);
        if (!w) return missing();
        if (["completed", "failed", "cancelled"].includes(String(w.status)))
          return conflict();
        const time = now();
        run(
          "UPDATE work_items SET status='cancelled',updated_at=? WHERE id=?",
          time,
          req.params.id,
        );
        resolveNotifications("work_item_id", req.params.id, time);
        run(
          "UPDATE schedules SET status='cancelled',updated_at=? WHERE owner_kind='work_item' AND owner_id=? AND status IN ('active','paused')",
          time,
          req.params.id,
        );
        run(
          "UPDATE executions SET status='failed',error=?,finished_at=?,lease_token=NULL WHERE work_item_id=? AND status='running'",
          json({
            code: "execution_outcome_unknown",
            message:
              "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
            retryable: false,
          }),
          time,
          req.params.id,
        );
        run(
          "UPDATE executions SET status='cancelled',finished_at=?,lease_token=NULL WHERE work_item_id=? AND status IN ('queued','claimed','retry_wait')",
          time,
          req.params.id,
        );
        run(
          "UPDATE interactions SET status='cancelled' WHERE work_item_id=? AND status='open'",
          req.params.id,
        );
        return { ok: true };
      }),
  );
  const tickScheduler = (): number => {
    const tickNow = clockNow();
    const time = new Date(tickNow).toISOString();
    tx(() => expireExecutions(time));
    const isolated = new Set<string>();
    let count = 0;
    for (;;) {
      const fired = tx(() => {
        const exclusions = [...isolated];
        const schedule = get(
          `SELECT * FROM schedules WHERE status='active' AND next_fire_at<=? AND (owner_kind<>'work_item' OR NOT EXISTS(SELECT 1 FROM work_items w JOIN automation_roots r ON r.id=w.root_id WHERE w.id=schedules.owner_id AND r.status IN ('blocked','completed','failed','cancelled','expired','budget_exhausted')))${exclusions.length ? ` AND id NOT IN (${exclusions.map(() => "?").join(",")})` : ""} ORDER BY next_fire_at,id LIMIT 1`,
          time,
          ...exclusions,
        );
        if (!schedule) return null;
        const scheduledFor = String(schedule.next_fire_at);
        const scheduleId = String(schedule.id);
        if (
          get(
            "SELECT id FROM schedule_firings WHERE schedule_id=? AND scheduled_for=?",
            scheduleId,
            scheduledFor,
          )
        )
          return { duplicate: true, scheduleId, scheduledFor };
        const firingId = randomUUID();
        run(
          "INSERT INTO schedule_firings(id,schedule_id,scheduled_for,created_at) VALUES(?,?,?,?)",
          firingId,
          String(schedule.id),
          scheduledFor,
          time,
        );
        if (schedule.owner_kind === "user") {
          const created = createEvent(
            {
              source: schedule.source,
              type: schedule.event_type,
              payload: JSON.parse(String(schedule.payload)),
            },
            time,
          );
          run(
            "UPDATE schedule_firings SET event_id=? WHERE id=?",
            String(created.event?.id),
            firingId,
          );
        } else {
          const parent = get(
            "SELECT * FROM executions WHERE id=?",
            String(schedule.parent_execution_id),
          );
          const work = get(
            "SELECT * FROM work_items WHERE id=?",
            String(schedule.owner_id),
          );
          if (
            parent &&
            work &&
            work.status === "waiting_schedule" &&
            schedule.reason === "retry"
          ) {
            const previousError: unknown = parent.error
              ? JSON.parse(String(parent.error))
              : null;
            if (!object(previousError) || previousError.safeToRetry !== true) {
              const unknown = {
                code: "execution_outcome_unknown",
                causeCode: object(previousError)
                  ? String(previousError.code ?? "")
                  : "",
                message:
                  "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
                retryable: false,
              };
              run(
                "UPDATE executions SET error=? WHERE id=?",
                json(unknown),
                String(parent.id),
              );
              run(
                "UPDATE work_items SET status='failed',updated_at=? WHERE id=?",
                time,
                String(work.id),
              );
              run(
                "UPDATE schedules SET status='cancelled',next_fire_at=NULL,updated_at=? WHERE id=?",
                time,
                String(schedule.id),
              );
              createNotification(
                String(work.id),
                null,
                "work_item_failed",
                String(work.title),
                time,
                "execution_outcome_unknown",
              );
              return true;
            }
          }
          if (parent && work && work.status === "waiting_schedule") {
            const admission = inspectAdmission(
              db,
              String(parent.id),
              config,
              time,
              true,
            );
            if (
              admission.status === "denied" &&
              ["loop_max_runs_reached", "loop_deadline_reached"].includes(
                admission.reason,
              )
            ) {
              const r = get(
                "SELECT root_id FROM work_items WHERE id=?",
                String(work.id),
              );
              terminateForLimit(db, String(r?.root_id), admission.reason, time);
              return true;
            }
            const executionId = randomUUID();
            const retry = schedule.reason === "retry";
            run(
              "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,agent_session_id,not_before,input,created_at,trigger_kind,parent_execution_id,retry_attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              executionId,
              String(work.id),
              Number(parent.sequence) + 1,
              "queued",
              String(parent.agent_profile_id),
              parent.agent_session_id as SQLInputValue,
              time,
              json({}),
              time,
              retry ? "retry" : "scheduled_resume",
              String(parent.id),
              retry ? Number(parent.retry_attempt) + 1 : 0,
            );
            run(
              "UPDATE schedule_firings SET execution_id=? WHERE id=?",
              executionId,
              firingId,
            );
            run(
              "UPDATE work_items SET status='active',updated_at=? WHERE id=?",
              time,
              String(work.id),
            );
          }
        }
        const next =
          schedule.kind === "cron"
            ? nextCron(
                String(schedule.expression),
                String(schedule.timezone),
                tickNow,
              )
            : null;
        run(
          "UPDATE schedules SET status=?,last_fire_at=?,next_fire_at=?,updated_at=? WHERE id=?",
          next ? "active" : "completed",
          scheduledFor,
          next,
          time,
          String(schedule.id),
        );
        return true;
      });
      if (!fired) break;
      if (typeof fired === "object" && fired.duplicate) {
        isolated.add(fired.scheduleId);
        console.error(
          JSON.stringify({
            type: "schedule_firing_duplicate",
            scheduleId: fired.scheduleId,
            scheduledFor: fired.scheduledFor,
          }),
        );
        continue;
      }
      count++;
    }
    return count;
  };
  Object.assign(hub, { tickScheduler });
  let timer: ReturnType<typeof setInterval> | undefined;
  const processDecisions = () => {
    try {
      processPendingDecisions(db, { config, now: clockNow });
      processPendingMaterializations(db, config, clockNow, 100, (id, code) =>
        hub.log.warn(
          { decisionId: id, code },
          "decision materialization deferred",
        ),
      );
      tx(() => {
        const time = now();
        expireQueuedAutomations(db, time);
        recoverContinuations(db, config, time);
      });
    } catch {
      hub.log.error("decision recovery failed");
    }
  };
  hub.addHook("onReady", async () => {
    processDecisions();
    if (pollIntervalMs > 0) {
      timer = setInterval(() => {
        try {
          tickScheduler();
          processDecisions();
        } catch {
          hub.log.error("scheduler tick failed");
        }
      }, pollIntervalMs);
      timer.unref();
      try {
        tickScheduler();
      } catch {
        hub.log.error("scheduler tick failed");
      }
    }
  });
  hub.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });
  const createEvent = (b: Row, eventTime?: string) => {
    if (b.source !== "local") return missing();
    const route = config.routes.find(
      (r) => r.event.source === b.source && r.event.type === b.type,
    );
    if (!route) return missing();
    const profile = config.agents[route.agent];
    const time = eventTime ?? now(),
      eventId = randomUUID(),
      workId = randomUUID(),
      executionId = randomUUID();
    run(
      "INSERT INTO events(id,source,type,payload,created_at) VALUES(?,?,?,?,?)",
      eventId,
      b.source as string,
      b.type as string,
      json(b.payload),
      time,
    );
    run(
      "INSERT INTO agent_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,adapter=excluded.adapter,model=excluded.model,reasoning=excluded.reasoning,config=excluded.config",
      route.agent,
      route.agent,
      profile.adapter,
      profile.model ?? null,
      profile.reasoning ?? null,
      json({
        ...(profile.config ?? {}),
        isolation: profile.isolation ?? "trusted-local",
        ...(profile.workspaceRoot
          ? { workspaceRoot: profile.workspaceRoot }
          : {}),
      }),
    );
    const rootId = randomUUID();
    run(
      "INSERT INTO automation_roots(id,definition_id,definition_version,mode,status,created_at,updated_at) VALUES(?,'system/manual',1,'manual','active',?,?)",
      rootId,
      time,
      time,
    );
    run(
      "INSERT INTO work_items(id,title,status,route_id,agent_profile_id,created_at,updated_at,completed_at,metadata,root_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
      workId,
      route.title,
      "active",
      route.id,
      route.agent,
      time,
      time,
      null,
      json({
        eventId,
        instruction: route.instruction ?? "",
        retryPolicy: route.retryPolicy ?? null,
        notify:
          route.notify ??
          Object.keys(config.channels ?? { local: { type: "local-console" } }),
        notifyOnCompleted: route.notifyOnCompleted ?? false,
      }),
      rootId,
    );
    run(
      "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,not_before,input,created_at) VALUES(?,?,?,?,?,?,?,?)",
      executionId,
      workId,
      1,
      "queued",
      route.agent,
      time,
      json(b.payload),
      time,
    );
    return {
      event: shape(get("SELECT * FROM events WHERE id=?", eventId)),
      workItem: shape(get("SELECT * FROM work_items WHERE id=?", workId)),
      execution: shape(get("SELECT * FROM executions WHERE id=?", executionId)),
    };
  };
  hub.post("/api/events/v2", { bodyLimit: 131072 }, async (req, reply) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip))
      throw new TaskCircuitError(
        "event_source_invalid",
        "事件入口仅接受本机连接",
        403,
      );
    const b = req.body;
    if (!object(b))
      throw new TaskCircuitError("event_invalid", "事件格式不正确", 400);
    const { sourceContext, envelope } = sourcePlugin.ingest(b);
    const result = ingestEvent(db, sourceContext, envelope, {
      knownTypes: new Set(config.routes.map((r) => r.event.type)),
      now: clockNow,
    });
    if (result.status === "conflict")
      return reply.code(409).send({
        error: {
          code: "event_delivery_conflict",
          message: "事件投递标识与已有内容不一致",
        },
        eventId: result.eventId,
      });
    processDecisions();
    return result;
  });
  hub.post<{ Params: { id: string } }>(
    "/api/events/:id/decide",
    async (req) => {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip))
        throw new TaskCircuitError(
          "decision_source_invalid",
          "决策入口仅接受本机连接",
          403,
        );
      const b = req.body;
      if (
        !object(b) ||
        Object.keys(b).some(
          (k) =>
            ![
              "requestId",
              "rootId",
              "generation",
              "expectedRootVersion",
            ].includes(k),
        ) ||
        typeof b.requestId !== "string" ||
        b.requestId.startsWith("auto:") ||
        typeof b.rootId !== "string"
      )
        throw new TaskCircuitError("decision_invalid", "决策请求不正确", 400);
      return evaluateDecision(
        db,
        {
          requestId: b.requestId,
          eventId: req.params.id,
          rootId: b.rootId,
          generation: (b.generation ?? 1) as number,
          expectedRootVersion: b.expectedRootVersion as number | undefined,
        },
        { config, now: clockNow },
      );
    },
  );
  hub.post<{ Params: { id: string } }>(
    "/api/decisions/:id/materialize",
    async (req) => {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip))
        throw new TaskCircuitError(
          "decision_source_invalid",
          "仅接受本机连接",
          403,
        );
      return materializeDecision(db, req.params.id, config, clockNow);
    },
  );
  hub.get<{ Params: { id: string } }>(
    "/api/decisions/:id",
    async (req) => getDecision(db, req.params.id) ?? missing(),
  );
  hub.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/roots/:id/decisions",
    async (req) => {
      const after = Number(req.query.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new TaskCircuitError("decision_invalid", "分页参数不正确", 400);
      return listRootDecisions(db, req.params.id, after);
    },
  );
  hub.get("/api/events/v2", async () =>
    all(
      "SELECT e.id,e.source,e.type,e.received_at,e.source_instance,e.trust_context,d.status FROM events e JOIN event_deliveries d ON d.event_id=e.id WHERE e.schema_version=1 ORDER BY e.received_at DESC,e.id DESC LIMIT 100",
    ).map(shape),
  );
  const eventDetails = (id: string, currentOnly: boolean) => {
    const e = get(
      currentOnly
        ? "SELECT * FROM events WHERE id=? AND schema_version=1"
        : "SELECT * FROM events WHERE id=?",
      id,
    );
    if (!e) return missing();
    const d = get(
      "SELECT source_instance,source_event_id,status,received_at FROM event_deliveries WHERE event_id=?",
      id,
    );
    const links = all(
      "SELECT l.root_id,l.relationship,l.sequence,r.predecessor_root_id FROM event_root_links l JOIN automation_roots r ON r.id=l.root_id WHERE l.event_id=? ORDER BY l.sequence",
      id,
    );
    const history = all(
      "SELECT h.sequence,h.state,h.recorded_at FROM event_delivery_history h JOIN event_deliveries d ON d.id=h.delivery_id WHERE d.event_id=? ORDER BY h.sequence LIMIT 100",
      id,
    );
    return {
      event: shape(e),
      delivery: shape(d),
      roots: links.map(shape),
      history: history.map(shape),
    };
  };
  hub.get<{ Params: { id: string } }>("/api/events/:id", async (req) =>
    eventDetails(req.params.id, false),
  );
  hub.get<{ Params: { id: string } }>("/api/events/v2/:id", async (req) =>
    eventDetails(req.params.id, true),
  );
  hub.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/api/roots/:id/events",
    async (req) => {
      if (!get("SELECT id FROM automation_roots WHERE id=?", req.params.id))
        return missing();
      const cursor = req.query.after ?? "0";
      if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
        return bad("事件游标不正确");
      return all(
        "SELECT e.id,e.source,e.type,e.received_at,e.occurred_at,e.source_instance,e.trust_context,l.sequence,l.relationship FROM event_root_links l JOIN events e ON e.id=l.event_id WHERE l.root_id=? AND l.sequence>? ORDER BY l.sequence LIMIT 100",
        req.params.id,
        Number(cursor),
      ).map(shape);
    },
  );
  hub.post("/api/events", async (req) => {
    const b = req.body;
    if (!object(b) || !str(b.source) || !str(b.type) || !object(b.payload))
      return bad("事件格式不正确");
    return tx(() => createEvent(b));
  });
  hub.get("/api/work-items", async () =>
    all("SELECT id FROM work_items ORDER BY created_at DESC LIMIT 50").map(
      (w) => {
        const d = details(String(w.id));
        return {
          workItem: d.workItem,
          latestExecution: d.executions.at(-1),
          waitingInteraction:
            d.interactions.find((i) => i?.status === "open") ?? null,
        };
      },
    ),
  );
  hub.get<{ Params: { id: string } }>("/api/work-items/:id", async (req) =>
    details(req.params.id),
  );
  hub.post<{ Params: { id: string } }>(
    "/api/interactions/:id/answer",
    async (req) => {
      const b = req.body;
      if (!object(b) || !str(b.answer)) return bad("请提供回答");
      return tx(() => {
        const q = get("SELECT * FROM interactions WHERE id=?", req.params.id);
        if (!q) return missing();
        if (q.status !== "open") return conflict();
        if (
          !get(
            "SELECT 1 FROM work_items w JOIN automation_roots r ON r.id=w.root_id WHERE w.id=? AND r.status IN ('active','waiting')",
            String(q.work_item_id),
          )
        )
          return conflict();
        const request = JSON.parse(String(q.request)) as Row;
        if (
          Array.isArray(request.options) &&
          !request.options.includes(b.answer)
        )
          return bad("回答不在可选项中");
        const e = get(
          "SELECT * FROM executions WHERE id=?",
          String(q.execution_id),
        );
        if (!e) throw new Error("missing execution");
        const time = now();
        run(
          "UPDATE interactions SET status='resolved',response=?,resolved_at=? WHERE id=?",
          json(b.answer),
          time,
          String(q.id),
        );
        resolveNotifications("interaction_id", String(q.id), time);
        const admission = inspectAdmission(
          db,
          String(e.id),
          config,
          time,
          true,
        );
        if (
          admission.status === "denied" &&
          ["loop_max_runs_reached", "loop_deadline_reached"].includes(
            admission.reason,
          )
        ) {
          const r = get(
            "SELECT root_id FROM work_items WHERE id=?",
            String(q.work_item_id),
          );
          terminateForLimit(db, String(r?.root_id), admission.reason, time);
          return { ok: true, admission: admission.reason };
        }
        run(
          "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,agent_session_id,not_before,input,created_at,trigger_kind,parent_execution_id,retry_attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          randomUUID(),
          String(q.work_item_id),
          Number(e.sequence) + 1,
          "queued",
          String(e.agent_profile_id),
          String(e.agent_session_id),
          time,
          json({ answer: b.answer, interactionId: q.id }),
          time,
          "human_answer",
          String(e.id),
          0,
        );
        run(
          "UPDATE work_items SET status='active',updated_at=? WHERE id=?",
          time,
          String(q.work_item_id),
        );
        return { ok: true };
      });
    },
  );
  const unknownExecutionError = {
    code: "execution_outcome_unknown",
    message:
      "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
    retryable: false,
  };
  const expireExecutions = (time = now()) => {
    for (const e of all(
      "SELECT id,work_item_id FROM executions WHERE status='running' AND lease_expires_at<=?",
      time,
    )) {
      run(
        "UPDATE executions SET status='failed',error=?,finished_at=?,lease_token=NULL WHERE id=? AND status='running' AND lease_expires_at<=?",
        json(unknownExecutionError),
        time,
        String(e.id),
        time,
      );
      run(
        "UPDATE schedules SET status='cancelled',updated_at=? WHERE parent_execution_id=? AND status IN ('active','paused')",
        time,
        String(e.id),
      );
      run(
        "UPDATE work_items SET status='failed',updated_at=? WHERE id=? AND status='active'",
        time,
        String(e.work_item_id),
      );
      createNotification(
        String(e.work_item_id),
        null,
        "work_item_failed",
        "执行结果需要核实",
        time,
        "execution_outcome_unknown",
      );
    }
  };
  hub.post("/api/executions/claim", async (req, reply) => {
    const b = req.body;
    if (!object(b) || !str(b.workerId)) return bad("请提供 workerId");
    const workerId = b.workerId;
    const result = tx(() => {
      expireExecutions();
      const time = now();
      recoverContinuations(db, config, time);
      let e = get(claimCandidateSql, time);
      let admission = e
        ? inspectAdmission(db, String(e.id), config, time)
        : undefined;
      while (e && admission && admission.status === "denied") {
        const root = get(
          "SELECT r.id,r.mode FROM automation_roots r JOIN work_items w ON w.root_id=r.id WHERE w.id=?",
          String(e.work_item_id),
        );
        if (root?.mode !== "automation") return null;
        if (
          ["loop_max_runs_reached", "loop_deadline_reached"].includes(
            admission.reason,
          )
        )
          terminateForLimit(db, String(root.id), admission.reason, time);
        else
          run(
            "UPDATE automation_roots SET status='blocked',terminal_reason=?,updated_at=?,version=version+1 WHERE id=? AND status IN ('active','waiting')",
            admission.reason,
            time,
            String(root.id),
          );
        e = get(claimCandidateSql, time);
        admission = e
          ? inspectAdmission(db, String(e.id), config, time)
          : undefined;
      }
      if (!e || !admission || admission.status !== "admitted") return null;
      const token = randomUUID();
      run(
        "UPDATE executions SET status='running',claimed_by=?,lease_token=?,lease_expires_at=?,started_at=COALESCE(started_at,?) WHERE id=?",
        workerId,
        token,
        expiry(),
        time,
        String(e.id),
      );
      return {
        execution: shape(
          get("SELECT * FROM executions WHERE id=?", String(e.id)),
        ),
        agentSession: e.agent_session_id
          ? shape(
              get(
                "SELECT * FROM agent_sessions WHERE id=?",
                String(e.agent_session_id),
              ),
            )
          : null,
        leaseToken: token,
        ...(admission.workspace
          ? {
              automationWorkspace: admission.workspace,
              automationRemainingMs: Math.max(
                0,
                Date.parse(String(admission.deadlineAt)) - Date.parse(time),
              ),
            }
          : {}),
        agentProfile: shape(
          get(
            "SELECT * FROM agent_profiles WHERE id=?",
            String(e.agent_profile_id),
          ),
        ),
        workItem: shape(
          get("SELECT * FROM work_items WHERE id=?", String(e.work_item_id)),
        ),
        previousInteractions: all(
          "SELECT * FROM interactions WHERE work_item_id=? AND status='resolved' ORDER BY created_at",
          String(e.work_item_id),
        ).map(shape),
        event: shape(
          get(
            "SELECT events.* FROM events JOIN work_items ON json_extract(work_items.metadata, '$.eventId')=events.id WHERE work_items.id=?",
            String(e.work_item_id),
          ),
        ),
      };
    });
    return result ?? reply.code(204).send();
  });
  const valid = (id: string, b: Row) =>
    get(
      "SELECT * FROM executions WHERE id=? AND status='running' AND claimed_by=? AND lease_token=? AND lease_expires_at>?",
      id,
      String(b.workerId),
      String(b.leaseToken),
      now(),
    );
  hub.post<{ Params: { id: string } }>(
    "/api/executions/:id/authorize-start",
    async (req) => {
      const b = req.body;
      if (!object(b) || !str(b.workerId) || !str(b.leaseToken))
        return bad("启动参数不正确");
      return tx(() => {
        const e = valid(req.params.id, b);
        if (!e) return conflict();
        const r = get(
          "SELECT r.id,r.mode,r.deadline_at FROM automation_roots r JOIN work_items w ON w.root_id=r.id WHERE w.id=?",
          String(e.work_item_id),
        );
        if (r?.mode !== "automation") return { status: "admitted" };
        const time = now();
        const admission = inspectAdmission(
          db,
          req.params.id,
          config,
          time,
          false,
          true,
        );
        if (b.abandon === true) {
          run(
            "UPDATE executions SET status='cancelled',finished_at=?,lease_token=NULL WHERE id=?",
            time,
            req.params.id,
          );
          if (time >= String(r.deadline_at))
            terminateForLimit(db, String(r.id), "loop_deadline_reached", time);
          else
            run(
              "UPDATE automation_roots SET status='blocked',terminal_reason='deadline_uncertain',updated_at=?,version=version+1 WHERE id=? AND status IN ('active','waiting')",
              time,
              String(r.id),
            );
          return {
            status: "denied",
            reason:
              time >= String(r.deadline_at)
                ? "loop_deadline_reached"
                : "deadline_uncertain",
          };
        }
        if (admission.status !== "admitted") {
          run(
            "UPDATE executions SET status='cancelled',finished_at=?,lease_token=NULL WHERE id=?",
            time,
            req.params.id,
          );
          if (
            ["loop_deadline_reached", "loop_max_runs_reached"].includes(
              admission.reason,
            )
          )
            terminateForLimit(db, String(r.id), admission.reason, time);
          else
            run(
              "UPDATE automation_roots SET status='blocked',terminal_reason=?,updated_at=?,version=version+1 WHERE id=? AND status IN ('active','waiting')",
              admission.reason,
              time,
              String(r.id),
            );
          return { status: "denied", reason: admission.reason };
        }
        return {
          status: "admitted",
          remainingMs: Math.max(
            0,
            Date.parse(String(r.deadline_at)) - Date.parse(time),
          ),
        };
      });
    },
  );
  hub.post<{ Params: { id: string } }>(
    "/api/executions/:id/heartbeat",
    async (req) => {
      const b = req.body;
      if (!object(b) || !str(b.workerId) || !str(b.leaseToken))
        return bad("续租参数不正确");
      return tx(() => {
        if (!valid(req.params.id, b)) return conflict();
        run(
          "UPDATE executions SET lease_expires_at=? WHERE id=?",
          expiry(),
          req.params.id,
        );
        return { ok: true };
      });
    },
  );
  const receiptKey = "taskcircuitResultReceiptsV1";
  const findReceipt = (executionId: string): Row | null => {
    const row = get(
      "SELECT w.metadata FROM executions e JOIN work_items w ON w.id=e.work_item_id WHERE e.id=?",
      executionId,
    );
    if (!row) return null;
    const metadata: unknown = JSON.parse(String(row.metadata));
    if (!object(metadata)) throw new Error("invalid work metadata");
    const ledger = metadata[receiptKey];
    if (ledger === undefined) return null;
    if (!object(ledger)) throw new Error("invalid receipt ledger");
    const receipt = ledger[executionId];
    if (receipt === undefined) return null;
    if (!object(receipt)) throw new Error("invalid receipt");
    return receipt;
  };
  hub.get<{
    Params: { id: string; submissionId: string };
    Querystring: { digest?: string };
  }>("/api/executions/:id/result-submissions/:submissionId", async (req) => {
    if (
      !validSubmissionId(req.params.submissionId) ||
      !validDigest(req.query.digest)
    )
      return bad("回执参数不正确");
    const receipt = findReceipt(req.params.id);
    if (!receipt || receipt.submissionId !== req.params.submissionId)
      return { status: "not_found" };
    if (receipt.resultDigest !== req.query.digest) {
      console.error(
        JSON.stringify({
          component: "hub",
          event: "result_receipt_conflict",
          message: "结果回执冲突",
          executionId: req.params.id,
          submissionId: req.params.submissionId,
        }),
      );
      return conflict();
    }
    return { status: "committed", receipt };
  });
  hub.post<{ Params: { id: string } }>(
    "/api/executions/:id/result",
    async (req) => {
      const b = req.body;
      if (
        !object(b) ||
        !str(b.workerId) ||
        !str(b.leaseToken) ||
        !object(b.result)
      )
        return bad("结果格式不正确");
      const result = b.result;
      const hasIdentity =
        b.submissionId !== undefined || b.resultDigest !== undefined;
      if (
        hasIdentity &&
        (!validSubmissionId(b.submissionId) || !validDigest(b.resultDigest))
      )
        return bad("结果提交身份不正确");
      const wireDigest = hasIdentity ? resultDigest(result) : null;
      if (
        result.type === "failed" &&
        object(result.error) &&
        (result.error.code === "agent_timeout" ||
          (result.error.retryable === true &&
            result.error.safeToRetry !== true))
      ) {
        result.error = {
          code: "execution_outcome_unknown",
          causeCode: String(result.error.code),
          message:
            "执行结果需要核实。Agent 可能已经执行了外部操作；系统不会自动重新执行。请核实外部结果后再决定如何处理。",
          retryable: false,
        };
      }
      if (
        ![
          "completed",
          "needs_input",
          "failed",
          "later",
          "continue",
          "stop",
        ].includes(String(result.type))
      )
        return bad("结果类型不正确");
      if (
        result.type === "needs_input" &&
        (!str(result.sessionId) ||
          !object(result.request) ||
          !str(result.request.title) ||
          !str(result.request.text) ||
          !str(result.request.key) ||
          !Array.isArray(result.request.options) ||
          result.request.options.length === 0 ||
          !result.request.options.every(str))
      )
        return bad("问题格式不正确");
      if (
        result.type === "completed" &&
        (!str(result.sessionId) || typeof result.output !== "string")
      )
        return bad("完成结果不正确");
      if (
        (result.type === "continue" || result.type === "stop") &&
        (!str(result.sessionId) ||
          !str(result.message) ||
          Object.keys(result).some(
            (k) => !["type", "sessionId", "message"].includes(k),
          ))
      )
        return bad("反馈格式不正确");
      if (
        result.type === "later" &&
        (!str(result.sessionId) ||
          !str(result.message) ||
          (result.afterSeconds !== undefined) ===
            (result.runAt !== undefined) ||
          (result.afterSeconds !== undefined &&
            (!Number.isInteger(result.afterSeconds) ||
              Number(result.afterSeconds) < 1 ||
              Number(result.afterSeconds) > 31536000)) ||
          (result.runAt !== undefined && !validInstant(result.runAt)))
      )
        return bad("稍后执行时间不正确");
      if (
        result.type === "failed" &&
        typeof result.error !== "string" &&
        (!object(result.error) ||
          !str(result.error.code) ||
          !str(result.error.message))
      )
        return bad("失败结果不正确");
      return tx(() => {
        if (hasIdentity) {
          const receipt = findReceipt(req.params.id);
          if (receipt) {
            if (
              receipt.submissionId === b.submissionId &&
              receipt.resultDigest === b.resultDigest &&
              wireDigest === b.resultDigest
            )
              return { status: "already_committed", receipt };
            console.error(
              JSON.stringify({
                component: "hub",
                event: "result_submission_conflict",
                message: "结果提交冲突",
                executionId: req.params.id,
                submissionId: b.submissionId,
              }),
            );
            return conflict();
          }
          if (wireDigest !== b.resultDigest) return bad("结果摘要不匹配");
        }
        const e = valid(req.params.id, b);
        if (!e) return conflict();
        const time = now();
        let sid =
          typeof e.agent_session_id === "string" ? e.agent_session_id : null;
        if (sid && result.type !== "failed") {
          const existing = get(
            "SELECT external_session_id FROM agent_sessions WHERE id=?",
            sid,
          );
          if (!existing || existing.external_session_id !== result.sessionId)
            return conflict();
        }
        if (!sid && str(result.sessionId)) {
          sid = randomUUID();
          run(
            "INSERT INTO agent_sessions VALUES(?,?,?,?,?,?,?,?)",
            sid,
            String(e.work_item_id),
            String(
              get(
                "SELECT adapter FROM agent_profiles WHERE id=?",
                String(e.agent_profile_id),
              )?.adapter,
            ),
            result.sessionId,
            "active",
            time,
            time,
            "{}",
          );
        }
        if (result.type === "continue" || result.type === "stop") {
          run(
            "UPDATE executions SET status='completed',agent_session_id=?,output=?,finished_at=?,lease_token=NULL WHERE id=?",
            sid,
            json({ feedback: result.type, message: result.message }),
            time,
            String(e.id),
          );
          run(
            "UPDATE work_items SET status=?,updated_at=? WHERE id=?",
            result.type === "continue" ? "waiting_schedule" : "cancelled",
            time,
            String(e.work_item_id),
          );
        } else if (result.type === "later") {
          const due =
            result.runAt !== undefined
              ? new Date(String(result.runAt)).toISOString()
              : new Date(
                  clockNow() + Number(result.afterSeconds) * 1000,
                ).toISOString();
          if (due <= time) return bad("稍后执行时间必须在未来");
          run(
            "UPDATE executions SET status='completed',agent_session_id=?,output=?,finished_at=?,lease_token=NULL WHERE id=?",
            sid,
            json(result.message),
            time,
            String(e.id),
          );
          scheduleWork(
            String(e.work_item_id),
            String(e.id),
            "later",
            due,
            time,
          );
          run(
            "UPDATE work_items SET status='waiting_schedule',updated_at=? WHERE id=?",
            time,
            String(e.work_item_id),
          );
        } else if (result.type === "needs_input") {
          const q = result.request as Row;
          const interactionId = randomUUID();
          run(
            "INSERT INTO interactions VALUES(?,?,?,?,?,?,?,?,?,?)",
            interactionId,
            String(e.work_item_id),
            String(e.id),
            "ask",
            "open",
            String(q.key),
            json(q),
            null,
            time,
            null,
          );
          createNotification(
            String(e.work_item_id),
            interactionId,
            "interaction_required",
            String(q.title),
            time,
          );
          run(
            "UPDATE executions SET status='waiting_input',agent_session_id=?,finished_at=?,lease_token=NULL WHERE id=?",
            sid,
            time,
            String(e.id),
          );
          run(
            "UPDATE work_items SET status='waiting_input',updated_at=? WHERE id=?",
            time,
            String(e.work_item_id),
          );
        } else {
          const status = result.type === "completed" ? "completed" : "failed";
          run(
            "UPDATE executions SET status=?,agent_session_id=?,output=?,error=?,finished_at=?,lease_token=NULL WHERE id=?",
            status,
            sid,
            result.type === "completed" ? json(result.output) : null,
            result.type === "failed" ? json(result.error) : null,
            time,
            String(e.id),
          );
          const work = get(
            "SELECT * FROM work_items WHERE id=?",
            String(e.work_item_id),
          );
          const meta = work ? (JSON.parse(String(work.metadata)) as Row) : {};
          const policy = meta.retryPolicy;
          const err = object(result.error) ? result.error : null;
          const retryable =
            status === "failed" &&
            err?.retryable === true &&
            [
              "agent_execution",
              "rate_limited",
              "agent_reported_failure",
            ].includes(String(err.code));
          const attempt = Number(e.retry_attempt);
          if (
            retryable &&
            validPolicy(policy) &&
            attempt + 1 < policy.maxAttempts
          ) {
            const due = new Date(
              clockNow() + retryDelay(policy, attempt + 1) * 1000,
            ).toISOString();
            scheduleWork(
              String(e.work_item_id),
              String(e.id),
              "retry",
              due,
              time,
            );
            run(
              "UPDATE work_items SET status='waiting_schedule',updated_at=? WHERE id=?",
              time,
              String(e.work_item_id),
            );
          } else {
            run(
              "UPDATE work_items SET status=?,updated_at=?,completed_at=? WHERE id=?",
              status,
              time,
              status === "completed" ? time : null,
              String(e.work_item_id),
            );
            createNotification(
              String(e.work_item_id),
              null,
              status === "failed" ? "work_item_failed" : "work_item_completed",
              String(work?.title ?? "工作"),
              time,
              status === "failed" ? String(err?.code ?? "") : undefined,
            );
          }
        }
        if (hasIdentity) {
          const work = get(
            "SELECT metadata,status FROM work_items WHERE id=?",
            String(e.work_item_id),
          );
          const current = get(
            "SELECT status FROM executions WHERE id=?",
            req.params.id,
          );
          if (!work || !current) throw new Error("missing committed state");
          const metadata: unknown = JSON.parse(String(work.metadata));
          if (!object(metadata)) throw new Error("invalid work metadata");
          const existing = metadata[receiptKey];
          if (existing !== undefined && !object(existing))
            throw new Error("invalid receipt ledger");
          const ledger = object(existing) ? existing : {};
          const receipt = {
            executionId: req.params.id,
            submissionId: b.submissionId,
            resultDigest: b.resultDigest,
            acceptedAt: time,
            executionStatus: String(current.status),
            workItemStatus: String(work.status),
          };
          ledger[req.params.id] = receipt;
          metadata[receiptKey] = ledger;
          run(
            "UPDATE work_items SET metadata=? WHERE id=?",
            json(metadata),
            String(e.work_item_id),
          );
          return { status: "accepted", receipt };
        }
        return { ok: true };
      });
    },
  );
  tx(() => {
    for (const row of all(
      "SELECT i.id,i.work_item_id,i.request FROM interactions i WHERE i.status='open' AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.interaction_id=i.id AND n.kind='interaction_required')",
    )) {
      const request = JSON.parse(String(row.request)) as Row;
      createNotification(
        String(row.work_item_id),
        String(row.id),
        "interaction_required",
        String(request.title ?? "需要回答"),
        now(),
      );
    }
  });
  tx(() => {
    for (const entry of config.schedules ?? []) {
      if (!get("SELECT id FROM schedules WHERE config_key=?", entry.id)) {
        const schedule = parseUserSchedule({
          kind: "cron",
          expression: entry.cron,
          timezone: entry.timezone ?? "UTC",
          event: {
            source: entry.event.source,
            type: entry.event.type,
            payload: entry.event.payload ?? {},
          },
        });
        run(
          "UPDATE schedules SET config_key=? WHERE id=?",
          entry.id,
          String(schedule?.id),
        );
      }
    }
  });
  Object.assign(hub, {
    stopSources,
    stopChannels,
    getSourceHealth: () => activeSources.health(),
  });
  hub.addHook("onReady", async () => {
    try {
      await ingress?.start();
      await activeSources.start();
      ingress?.open();
    } catch (error) {
      await stopSources();
      throw error;
    }
  });
  hub.addHook("onClose", async () => {
    db.close();
  });
  return hub as typeof hub & {
    tickScheduler: () => number;
    readChanges: (after: number, limit?: number) => (Row | null)[];
    pruneChanges: (maxChanges?: number) => number;
    dispatchNotifications: () => Promise<void>;
    getStreamCount: () => number;
    stopSources: () => Promise<void>;
    stopChannels: () => Promise<void>;
    getSourceHealth: () => ReturnType<ActiveSources["health"]>;
  };
}
