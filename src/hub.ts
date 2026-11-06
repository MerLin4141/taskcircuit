import Fastify from "fastify";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { migrate } from "./migration.js";
import type { Config } from "./config.js";
import { TaskCircuitError } from "./domain.js";

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
  clock: () => number = Date.now,
) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
  migrate(db);
  const hub = Fastify({ logger: false });
  const run = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).run(...args);
  const get = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).get(...args) as Row | undefined;
  const all = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args) as Row[];
  const now = () => new Date(clock()).toISOString();
  const expiry = () => new Date(clock() + 30000).toISOString();
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
      executions: all(
        "SELECT * FROM executions WHERE work_item_id=? ORDER BY sequence",
        workId,
      ).map(shape),
      agentSession: shape(
        get("SELECT * FROM agent_sessions WHERE work_item_id=?", workId),
      ),
      interactions: all(
        "SELECT * FROM interactions WHERE work_item_id=? ORDER BY created_at",
        workId,
      ).map(shape),
    };
  };
  hub.get("/api/health", async () => ({ ok: true, service: "taskcircuit" }));
  hub.post("/api/events", async (req) => {
    const b = req.body;
    if (!object(b) || !str(b.source) || !str(b.type) || !object(b.payload))
      return bad("事件格式不正确");
    const route = config.routes.find(
      (r) => r.event.source === b.source && r.event.type === b.type,
    );
    if (!route) return missing();
    const profile = config.agents[route.agent];
    return tx(() => {
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
        json(profile.config ?? {}),
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
        json({ eventId }),
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
        execution: shape(
          get("SELECT * FROM executions WHERE id=?", executionId),
        ),
      };
    });
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
          "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,agent_session_id,not_before,input,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          randomUUID(),
          String(q.work_item_id),
          Number(e.sequence) + 1,
          "queued",
          String(e.agent_profile_id),
          String(e.agent_session_id),
          time,
          json({ answer: b.answer, interactionId: q.id }),
          time,
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
      if (!["completed", "needs_input", "failed"].includes(String(result.type)))
        return bad("结果类型不正确");
      if (
        result.type === "needs_input" &&
        (!str(result.sessionId) ||
          !object(result.request) ||
          !str(result.request.title) ||
          !str(result.request.text) ||
          !str(result.request.key) ||
          !Array.isArray(result.request.options) ||
          !result.request.options.every(str))
      )
        return bad("问题格式不正确");
      if (
        result.type === "completed" &&
        (!str(result.sessionId) || typeof result.output !== "string")
      )
        return bad("完成结果不正确");
      if (result.type === "failed" && typeof result.error !== "string")
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
            "mock",
            result.sessionId,
            "active",
            time,
            time,
            "{}",
          );
        }
        if (result.type === "needs_input") {
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
  hub.addHook("onClose", async () => {
    db.close();
  });
  return hub;
}
