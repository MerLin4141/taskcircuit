// Guards deadline boundaries for human answers and durable scheduled resumes.
import { it, expect } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { workOnce } from "../src/worker.js";
it("records an answer after deadline without creating another Execution", async () => {
  const f = await setupLoop(3, 1);
  try {
    expect(
      await workOnce(f.base, "w", {
        async execute() {
          return {
            type: "needs_input",
            sessionId: "fake",
            request: { title: "q", text: "q", key: "q", options: ["yes"] },
          };
        },
      }),
    ).toBe(true);
    const q = f.db.prepare("SELECT id FROM interactions").get()!;
    f.advance(1000);
    const answer = await f.hub.inject({
      method: "POST",
      url: `/api/interactions/${q.id}/answer`,
      payload: { answer: "yes" },
    });
    expect(answer.statusCode).toBe(200);
    expect(
      f.db.prepare("SELECT status FROM interactions WHERE id=?").get(q.id)
        ?.status,
    ).toBe("resolved");
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(1);
    expect(
      f.db
        .prepare("SELECT terminal_reason FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.terminal_reason,
    ).toBe("loop_deadline_reached");
  } finally {
    await f.close();
  }
});
it("does not create a scheduled resume after deadline", async () => {
  const f = await setupLoop(3, 1);
  try {
    expect(
      await workOnce(f.base, "w", {
        async execute() {
          return {
            type: "later",
            sessionId: "fake",
            message: "later",
            afterSeconds: 2,
          };
        },
      }),
    ).toBe(true);
    f.advance(2000);
    f.hub.tickScheduler();
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(1);
    expect(
      f.db
        .prepare("SELECT terminal_reason FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.terminal_reason,
    ).toBe("loop_deadline_reached");
  } finally {
    await f.close();
  }
});

it("rechecks deadline immediately before starting a claimed Agent", async () => {
  const f = await setupLoop(3, 1);
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith("/api/executions/claim")) f.advance(1000);
      return response;
    };
    await workOnce(f.base, "w", {
      async execute() {
        calls++;
        return { type: "completed", sessionId: "fake", output: "done" };
      },
    });
    expect(calls).toBe(0);
    expect(
      f.db
        .prepare("SELECT terminal_reason FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.terminal_reason,
    ).toBe("loop_deadline_reached");
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

it("does not kill an in-flight Agent solely because the deadline passes", async () => {
  const f = await setupLoop(3, 1);
  try {
    let calls = 0;
    expect(
      await workOnce(f.base, "w", {
        async execute() {
          calls++;
          f.advance(1000);
          return { type: "continue", sessionId: "fake", message: "next" };
        },
      }),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(f.db.prepare("SELECT status FROM executions").get()?.status).toBe(
      "completed",
    );
    expect(
      await workOnce(f.base, "w", {
        async execute() {
          calls++;
          return { type: "completed", sessionId: "fake", output: "bad" };
        },
      }),
    ).toBe(false);
    expect(calls).toBe(1);
    expect(
      f.db
        .prepare("SELECT terminal_reason FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.terminal_reason,
    ).toBe("loop_deadline_reached");
  } finally {
    await f.close();
  }
});

it("expires a queued Root on restart after downtime beyond the deadline", async () => {
  const f = await setupLoop(3, 1);
  try {
    f.advance(1001);
    await f.restart();
    expect(
      f.db
        .prepare(
          "SELECT status,terminal_reason FROM automation_roots WHERE id=?",
        )
        .get(f.ev.rootId),
    ).toMatchObject({
      status: "expired",
      terminal_reason: "loop_deadline_reached",
    });
    expect(
      f.db
        .prepare("SELECT COUNT(*) n FROM executions WHERE status='running'")
        .get()?.n,
    ).toBe(0);
  } finally {
    await f.close();
  }
});

it("rejects a changed trusted Agent profile between claim and launch", async () => {
  const f = await setupLoop(3, 120);
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith("/api/executions/claim"))
        f.config.agents = {
          ...f.config.agents,
          "demo-agent": { adapter: "mock", model: "changed" },
        };
      return response;
    };
    await workOnce(f.base, "w", {
      async execute() {
        calls++;
        return { type: "completed", sessionId: "fake", output: "done" };
      },
    });
    expect(calls).toBe(0);
    expect(
      f.db
        .prepare(
          "SELECT status,terminal_reason FROM automation_roots WHERE id=?",
        )
        .get(f.ev.rootId),
    ).toMatchObject({
      status: "blocked",
      terminal_reason: "authorization_changed",
    });
  } finally {
    globalThis.fetch = original;
    await f.close();
  }
});

it("recognizes an expired deadline even if another Work Item is busy", async () => {
  const f = await setupLoop(3, 1);
  try {
    const { inspectAdmission } = await import("../src/execution-admission.js");
    const work = f.db.prepare("SELECT * FROM work_items LIMIT 1").get()!;
    const e = f.db.prepare("SELECT * FROM executions LIMIT 1").get()!;
    f.db
      .prepare(
        "INSERT INTO work_items(id,title,status,route_id,agent_profile_id,created_at,updated_at,metadata,root_id) VALUES('other',?,?,?,?,?,?,?,?)",
      )
      .run(
        work.title,
        work.status,
        work.route_id,
        work.agent_profile_id,
        work.created_at,
        work.updated_at,
        work.metadata,
        work.root_id,
      );
    f.db
      .prepare(
        "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,not_before,input,created_at,started_at) VALUES('running','other',1,'running',?,?,?,?,?)",
      )
      .run(
        e.agent_profile_id,
        e.not_before,
        e.input,
        e.created_at,
        e.created_at,
      );
    expect(
      inspectAdmission(
        f.db,
        String(e.id),
        f.config,
        "2026-01-01T00:00:01.000Z",
      ),
    ).toMatchObject({ status: "denied", reason: "loop_deadline_reached" });
  } finally {
    await f.close();
  }
});

it("keeps a late answer while another execution finishes, then expires the Root", async () => {
  const f = await setupLoop(3, 1);
  try {
    expect(
      await workOnce(f.base, "w", {
        async execute() {
          return {
            type: "needs_input",
            sessionId: "fake",
            request: { title: "q", text: "q", key: "q", options: ["yes"] },
          };
        },
      }),
    ).toBe(true);
    const work = f.db.prepare("SELECT * FROM work_items LIMIT 1").get()!;
    const e = f.db.prepare("SELECT * FROM executions LIMIT 1").get()!;
    f.db
      .prepare(
        "INSERT INTO work_items(id,title,status,route_id,agent_profile_id,created_at,updated_at,metadata,root_id) VALUES('other',?,?,?,?,?,?,?,?)",
      )
      .run(
        work.title,
        "active",
        work.route_id,
        work.agent_profile_id,
        work.created_at,
        work.updated_at,
        work.metadata,
        work.root_id,
      );
    f.db
      .prepare(
        "INSERT INTO executions(id,work_item_id,sequence,status,agent_profile_id,not_before,input,created_at,started_at) VALUES('running','other',1,'running',?,?,?,?,?)",
      )
      .run(
        e.agent_profile_id,
        e.not_before,
        e.input,
        e.created_at,
        e.created_at,
      );
    f.advance(1000);
    const q = f.db.prepare("SELECT id FROM interactions").get()!;
    expect(
      (
        await f.hub.inject({
          method: "POST",
          url: `/api/interactions/${q.id}/answer`,
          payload: { answer: "yes" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      f.db.prepare("SELECT status FROM interactions WHERE id=?").get(q.id)
        ?.status,
    ).toBe("resolved");
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(2);
    f.db
      .prepare("UPDATE executions SET status='completed' WHERE id='running'")
      .run();
    f.db
      .prepare("UPDATE work_items SET status='completed' WHERE id='other'")
      .run();
    await f.restart();
    expect(
      f.db
        .prepare(
          "SELECT status,terminal_reason FROM automation_roots WHERE id=?",
        )
        .get(f.ev.rootId),
    ).toMatchObject({
      status: "expired",
      terminal_reason: "loop_deadline_reached",
    });
  } finally {
    await f.close();
  }
});

it("does not launch if the wall clock jumps past deadline after preflight responds", async () => {
  const f = await setupLoop(3, 1);
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  let calls = 0,
    jumped = false;
  try {
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (!jumped && String(args[0]).endsWith("/authorize-start")) {
        jumped = true;
        f.advance(1000);
        Date.now = () => originalNow() + 2000;
      }
      return response;
    };
    await workOnce(f.base, "w", {
      async execute() {
        calls++;
        return { type: "completed", sessionId: "fake", output: "done" };
      },
    });
    expect(calls).toBe(0);
    expect(
      f.db
        .prepare("SELECT terminal_reason FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.terminal_reason,
    ).toBe("loop_deadline_reached");
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
    await f.close();
  }
});

it("never moves a frozen deadline later after wall-clock rollback", async () => {
  const f = await setupLoop(3, 1);
  try {
    const before = f.db
      .prepare("SELECT deadline_at FROM automation_roots WHERE id=?")
      .get(f.ev.rootId)?.deadline_at;
    f.advance(500);
    await f.restart();
    f.advance(-10000);
    await f.restart();
    expect(
      f.db
        .prepare("SELECT deadline_at FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.deadline_at,
    ).toBe(before);
    f.advance(10500);
    await f.restart();
    expect(
      f.db
        .prepare(
          "SELECT status,terminal_reason FROM automation_roots WHERE id=?",
        )
        .get(f.ev.rootId),
    ).toMatchObject({
      status: "expired",
      terminal_reason: "loop_deadline_reached",
    });
  } finally {
    await f.close();
  }
});
