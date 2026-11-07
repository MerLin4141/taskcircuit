// Guards atomic claims, stale results, durable answers, and session identity across restarts.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { MockAgentAdapter } from "../src/adapter.js";
import { workOnce } from "../src/worker.js";
import { DatabaseSync } from "node:sqlite";

const setup = (path = ":memory:", clock = () => Date.now()) =>
  createHub(path, defaultConfig, clock);
const post = (hub: ReturnType<typeof setup>, url: string, payload: unknown) =>
  hub.inject({ method: "POST", url, payload });
const event = (hub: ReturnType<typeof setup>) =>
  post(hub, "/api/events", {
    source: "local",
    type: "demo.color",
    payload: {},
  });
const claim = (hub: ReturnType<typeof setup>, workerId = "worker") =>
  post(hub, "/api/executions/claim", { workerId });
const submit = (
  hub: ReturnType<typeof setup>,
  c: any,
  result: unknown,
  workerId = "worker",
) =>
  post(hub, `/api/executions/${c.execution.id}/result`, {
    workerId,
    leaseToken: c.leaseToken,
    result,
  });

describe("TaskCircuit runtime", () => {
  it("migrates, routes exactly and persists work and execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-"));
    const db = join(dir, "db");
    let hub = setup(db);
    expect((await hub.inject("/api/health")).json()).toEqual({
      ok: true,
      service: "taskcircuit",
    });
    expect(
      (
        await post(hub, "/api/events", {
          source: "other",
          type: "demo.color",
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    const created = (await event(hub)).json();
    expect(created.workItem.status).toBe("active");
    expect(created.execution.status).toBe("queued");
    await hub.close();
    hub = setup(db);
    const detail = (
      await hub.inject(`/api/work-items/${created.workItem.id}`)
    ).json();
    expect(detail.workItem.id).toBe(created.workItem.id);
    expect(detail.executions[0].id).toBe(created.execution.id);
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("allows only one claim, honors heartbeat and fences expired workers", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const hub = setup(":memory:", () => now);
    await event(hub);
    const [a, b] = await Promise.all([claim(hub, "a"), claim(hub, "b")]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 204]);
    const first = a.statusCode === 200 ? a.json() : b.json();
    const owner = a.statusCode === 200 ? "a" : "b";
    now += 20000;
    expect(
      (
        await post(hub, `/api/executions/${first.execution.id}/heartbeat`, {
          workerId: owner,
          leaseToken: first.leaseToken,
        })
      ).statusCode,
    ).toBe(200);
    now += 15000;
    expect((await claim(hub, "c")).statusCode).toBe(204);
    now += 16000;
    const second = (await claim(hub, "c")).json();
    expect(second.execution.id).toBe(first.execution.id);
    expect(
      (await submit(hub, first, { type: "failed", error: "stale" }, owner))
        .statusCode,
    ).toBe(409);
    expect(
      (await submit(hub, second, { type: "failed", error: "test" }, "c"))
        .statusCode,
    ).toBe(200);
    await hub.close();
  });
  it("reopens an ask and resumes the same session exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-"));
    const db = join(dir, "db");
    let hub = setup(db);
    const created = (await event(hub)).json();
    const a = (await claim(hub)).json();
    const adapter = new MockAgentAdapter();
    const ask = await adapter.execute({
      workItemId: a.execution.workItemId,
      executionId: a.execution.id,
      externalSessionId: a.agentSession?.externalSessionId ?? null,
      workingDirectory: ".",
      instruction: "",
      context: {},
      previousAnswers: a.execution.input.answer
        ? [{ question: {}, answer: a.execution.input.answer }]
        : [],
    });
    expect(ask.type).toBe("needs_input");
    expect((await submit(hub, a, ask)).statusCode).toBe(200);
    let details = (
      await hub.inject(`/api/work-items/${created.workItem.id}`)
    ).json();
    expect(details.workItem.status).toBe("waiting_input");
    const sessionId = details.agentSession.id;
    const interactionId = details.interactions[0].id;
    expect(details.executions[0].agentSessionId).toBe(sessionId);
    await hub.close();
    hub = setup(db);
    details = (
      await hub.inject(`/api/work-items/${created.workItem.id}`)
    ).json();
    expect(details.interactions[0].status).toBe("open");
    expect(details.agentSession.id).toBe(sessionId);
    expect(
      (
        await post(hub, `/api/interactions/${interactionId}/answer`, {
          answer: "蓝色",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post(hub, `/api/interactions/${interactionId}/answer`, {
          answer: "绿色",
        })
      ).statusCode,
    ).toBe(409);
    const b = (await claim(hub)).json();
    expect(b.execution.id).not.toBe(a.execution.id);
    expect(b.execution.agentSessionId).toBe(sessionId);
    expect(b.agentSession.id).toBe(sessionId);
    const done = await adapter.execute({
      workItemId: b.execution.workItemId,
      executionId: b.execution.id,
      externalSessionId: b.agentSession?.externalSessionId ?? null,
      workingDirectory: ".",
      instruction: "",
      context: {},
      previousAnswers: b.execution.input.answer
        ? [{ question: {}, answer: b.execution.input.answer }]
        : [],
    });
    expect(done).toMatchObject({
      type: "completed",
      output: "你选了蓝色，TaskCircuit 试跑通过",
    });
    expect((await submit(hub, b, done)).statusCode).toBe(200);
    details = (
      await hub.inject(`/api/work-items/${created.workItem.id}`)
    ).json();
    expect(details.workItem.status).toBe("completed");
    expect(details.executions.map((e: any) => e.status)).toEqual([
      "waiting_input",
      "completed",
    ]);
    expect(details.interactions[0].response).toBe("蓝色");
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("persists migration and all domain records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-"));
    const path = join(dir, "db");
    const hub = setup(path);
    const created = (await event(hub)).json();
    const c = (await claim(hub)).json();
    const result = await new MockAgentAdapter().execute({
      workItemId: c.execution.workItemId,
      executionId: c.execution.id,
      externalSessionId: c.agentSession?.externalSessionId ?? null,
      workingDirectory: ".",
      instruction: "",
      context: {},
      previousAnswers: c.execution.input.answer
        ? [{ question: {}, answer: c.execution.input.answer }]
        : [],
    });
    await submit(hub, c, result);
    await hub.close();
    const db = new DatabaseSync(path);
    for (const table of [
      "schema_migrations",
      "events",
      "work_items",
      "executions",
      "agent_sessions",
      "interactions",
      "agent_profiles",
    ])
      expect(
        Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n),
      ).toBe(table === "schema_migrations" ? 4 : 1);
    expect(created.workItem.id).toBeTruthy();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  it("runs the mock adapter through the HTTP worker", async () => {
    const hub = setup();
    await hub.listen({ port: 0, host: "127.0.0.1" });
    const address = hub.server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const created = (await event(hub)).json();
    expect(await workOnce(base, "w")).toBe(true);
    let d = (await hub.inject(`/api/work-items/${created.workItem.id}`)).json();
    expect(d.workItem.status).toBe("waiting_input");
    expect(d.interactions[0].request.title).toBe("试跑：选一个颜色");
    await post(hub, `/api/interactions/${d.interactions[0].id}/answer`, {
      answer: "绿色",
    });
    expect(await workOnce(base, "w")).toBe(true);
    d = (await hub.inject(`/api/work-items/${created.workItem.id}`)).json();
    expect(d.executions[1].output).toBe("你选了绿色，TaskCircuit 试跑通过");
    expect(await workOnce(base, "w")).toBe(false);
    await hub.close();
  });
  it("makes a failed execution and its work terminal", async () => {
    const hub = setup();
    const created = (await event(hub)).json();
    const c = (await claim(hub)).json();
    expect(
      (await submit(hub, c, { type: "failed", error: "mock failure" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await submit(hub, c, { type: "failed", error: "again" })).statusCode,
    ).toBe(409);
    const d = (
      await hub.inject(`/api/work-items/${created.workItem.id}`)
    ).json();
    expect(d.workItem.status).toBe("failed");
    expect(d.executions[0].status).toBe("failed");
    expect((await claim(hub)).statusCode).toBe(204);
    await hub.close();
  });
});
