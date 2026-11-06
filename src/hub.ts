import Fastify from "fastify";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrate } from "./migration.js";
import type { Config } from "./config.js";
import { TaskCircuitError } from "./domain.js";
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
        run(
          "UPDATE schedules SET status='cancelled',updated_at=? WHERE owner_kind='work_item' AND owner_id=? AND status IN ('active','paused')",
          time,
          req.params.id,
        );
        run(
          "UPDATE executions SET status='cancelled',finished_at=?,lease_token=NULL WHERE work_item_id=? AND status IN ('queued','running','claimed','retry_wait')",
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
    let count = 0;
    for (;;) {
      const fired = tx(() => {
        const time = now();
        const schedule = get(
          "SELECT * FROM schedules WHERE status='active' AND next_fire_at<=? ORDER BY next_fire_at,id LIMIT 1",
          time,
        );
        if (!schedule) return false;
        const scheduledFor = String(schedule.next_fire_at);
        const firingId = randomUUID();
        run(
          "INSERT INTO schedule_firings(id,schedule_id,scheduled_for,created_at) VALUES(?,?,?,?)",
          firingId,
          String(schedule.id),
          scheduledFor,
          time,
        );
        if (schedule.owner_kind === "user") {
          const created = createEvent({
            source: schedule.source,
            type: schedule.event_type,
            payload: JSON.parse(String(schedule.payload)),
          });
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
                clockNow(),
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
  const createEvent = (b: Row) => {
    const route = config.routes.find(
      (r) => r.event.source === b.source && r.event.type === b.type,
    );
    if (!route) return missing();
    const profile = config.agents[route.agent];
    const time = now(),
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
  hub.post("/api/executions/claim", async (req, reply) => {
    const b = req.body;
    if (!object(b) || !str(b.workerId)) return bad("请提供 workerId");
    const workerId = b.workerId;
    const result = tx(() => {
      const time = now();
      const e = get(
        "SELECT * FROM executions WHERE (status='queued' AND not_before<=?) OR (status='running' AND lease_expires_at<=?) ORDER BY created_at,sequence LIMIT 1",
        time,
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
          run(
            "INSERT INTO interactions VALUES(?,?,?,?,?,?,?,?,?,?)",
            randomUUID(),
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
              "agent_unavailable",
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
          } else
            run(
              "UPDATE work_items SET status=?,updated_at=?,completed_at=? WHERE id=?",
              status,
              time,
              status === "completed" ? time : null,
              String(e.work_item_id),
            );
        }
        return { ok: true };
      });
    },
  );
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
  return hub as typeof hub & { tickScheduler: () => number };
}
