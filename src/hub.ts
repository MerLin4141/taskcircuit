import Fastify from "fastify";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  resultDigest,
  validDigest,
  validSubmissionId,
} from "./result-receipt.js";
import { migrate } from "./migration.js";
import type { Config } from "./config.js";
import { TaskCircuitError } from "./domain.js";
import {
  LocalConsoleChannel,
  type HubOptions,
  type NotificationChannel,
} from "./notifications.js";
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
) {
  const clockNow = typeof clock === "function" ? clock : () => clock.now();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);
  const hub = Fastify({ logger: false });
  const run = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).run(...args);
  const get = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args) as Row[];
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
  const channels: Record<string, NotificationChannel> =
    options.channels ??
    Object.fromEntries(
      Object.entries(
        config.channels ?? { local: { type: "local-console" } },
      ).map(([id]) => [id, new LocalConsoleChannel(id)]),
    );
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
    for (const close of [...streams]) close();
  });
  hub.addHook("onClose", async () => {
    if (dispatcherTimer) clearInterval(dispatcherTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    for (const close of streams) close();
    if (dispatching) await dispatching;
  });
  const bad = (message: string): never => {
    throw new TaskCircuitError("invalid_request", message, 400);
  };
  hub.setErrorHandler((error, _, reply) => {
    const e =
      error instanceof TaskCircuitError
        ? error
        : new TaskCircuitError("internal_error", "服务处理失败", 500);
    reply.code(e.status).send({ error: { code: e.code, message: e.message } });
  });
  const missing = () => {
    throw new TaskCircuitError("not_found", "没有找到对应记录", 404);
  };
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
  hub.get("/api/health", async () => ({ ok: true, service: "taskcircuit" }));
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
      !str(b.event.source) ||
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
          `SELECT * FROM schedules WHERE status='active' AND next_fire_at<=?${exclusions.length ? ` AND id NOT IN (${exclusions.map(() => "?").join(",")})` : ""} ORDER BY next_fire_at,id LIMIT 1`,
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
  hub.addHook("onReady", async () => {
    if (pollIntervalMs > 0) {
      timer = setInterval(() => {
        try {
          tickScheduler();
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
      "INSERT INTO events VALUES(?,?,?,?,?)",
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
    run(
      "INSERT INTO work_items VALUES(?,?,?,?,?,?,?,?,?)",
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
      const e = get(
        "SELECT * FROM executions WHERE status='queued' AND not_before<=? ORDER BY created_at,sequence LIMIT 1",
        time,
      );
      if (!e) return null;
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
        !["completed", "needs_input", "failed", "later"].includes(
          String(result.type),
        )
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
        if (result.type === "later") {
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
  hub.addHook("onClose", async () => {
    db.close();
  });
  return hub as typeof hub & {
    tickScheduler: () => number;
    readChanges: (after: number, limit?: number) => (Row | null)[];
    pruneChanges: (maxChanges?: number) => number;
    dispatchNotifications: () => Promise<void>;
    getStreamCount: () => number;
  };
}
