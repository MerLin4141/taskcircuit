// Guards durable observation, ordered replay, and notification delivery across crashes and answers.
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
const post = (h: ReturnType<typeof createHub>, url: string, payload: unknown) =>
  h.inject({ method: "POST", url, payload });
const event = (h: ReturnType<typeof createHub>, type = "demo.color") =>
  post(h, "/api/events", { source: "local", type, payload: {} });
async function ask(h: ReturnType<typeof createHub>) {
  const work = (await event(h)).json().workItem;
  const c = (await post(h, "/api/executions/claim", { workerId: "w" })).json();
  const result = {
    type: "needs_input",
    sessionId: "secret-external",
    request: {
      title: "选颜色",
      text: "请选择",
      options: ["蓝色", "绿色"],
      key: "color",
    },
  };
  expect(
    (
      await post(h, `/api/executions/${c.execution.id}/result`, {
        workerId: "w",
        leaseToken: c.leaseToken,
        result,
      })
    ).statusCode,
  ).toBe(200);
  return work;
}
const details = async (h: ReturnType<typeof createHub>, id: string) =>
  (await h.inject(`/api/work-items/${id}`)).json();
const start = async (h: ReturnType<typeof createHub>) => {
  await h.listen({ host: "127.0.0.1", port: 0 });
  const a = h.server.address();
  if (!a || typeof a === "string") throw Error("no port");
  return `http://127.0.0.1:${a.port}`;
};
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (s: string) => boolean,
) {
  let text = "";
  const decoder = new TextDecoder();
  while (!predicate(text)) {
    const part = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(Error("stream timeout")), 3000),
      ),
    ]);
    if (part.done) throw Error("stream ended");
    text += decoder.decode(part.value, { stream: true });
  }
  return text;
}
describe("durable observation and inbox", () => {
  it("records transactional changes and excludes full context and session IDs", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const w = await ask(h);
      const response = await h.inject("/api/state");
      const state = response.json();
      expect(state.inbox).toHaveLength(1);
      const changes = h.readChanges(0);
      expect(changes.map((c: any) => c.type)).toContain("interaction.opened");
      expect(changes.map((c: any) => c.sequence)).toEqual(
        [...changes.map((c: any) => c.sequence)].sort(
          (a: number, b: number) => a - b,
        ),
      );
      expect(JSON.stringify(changes)).not.toContain("secret-external");
      const before = (await h.inject("/api/stream/head")).json().sequence;
      const d = await details(h, w.id);
      expect(
        (
          await post(h, `/api/interactions/${d.interactions[0].id}/answer`, {
            answer: "incorrect",
          })
        ).statusCode,
      ).toBe(400);
      expect((await h.inject("/api/stream/head")).json().sequence).toBe(before);
    } finally {
      await h.close();
    }
  });
  it("creates inbox, notification and delivery atomically and cancels pending delivery on answer", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const w = await ask(h);
      const inbox = (await h.inject("/api/inbox")).json();
      expect(inbox).toHaveLength(1);
      expect(JSON.stringify(inbox)).not.toContain("secret-external");
      let n = (await h.inject("/api/notifications")).json();
      expect(n[0].status).toBe("open");
      expect(n[0].deliveries[0].status).toBe("queued");
      await post(h, `/api/interactions/${inbox[0].interactionId}/answer`, {
        answer: "蓝色",
      });
      expect((await h.inject("/api/inbox")).json()).toHaveLength(0);
      n = (await h.inject("/api/notifications")).json();
      expect(n[0].status).toBe("resolved");
      expect(n[0].deliveries[0].status).toBe("cancelled");
      expect((await details(h, w.id)).workItem.status).toBe("active");
    } finally {
      await h.close();
    }
  });
  it("retries delivery on failure and recovers queued delivery after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-notify-"));
    const db = join(dir, "db");
    let now = Date.parse("2026-01-01T00:00:00Z");
    let calls = 0;
    const channels = {
      local: {
        id: "local",
        deliver: async () => {
          calls++;
          if (calls === 1) throw Error("failure");
          return { ok: true };
        },
      },
    };
    let h = createHub(db, defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
      channels,
    });
    try {
      await ask(h);
      await h.dispatchNotifications();
      let n = (await h.inject("/api/notifications")).json();
      expect(n[0].deliveries[0].status).toBe("queued");
      await h.close();
      now += 5000;
      h = createHub(db, defaultConfig, () => now, 0, {
        dispatcherPollMs: 0,
        channels,
      });
      await h.dispatchNotifications();
      n = (await h.inject("/api/notifications")).json();
      expect(n[0].deliveries[0].status).toBe("sent");
      expect(calls).toBe(2);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("replays and follows ordered SSE with last event id and cleans up clients", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
      streamPollMs: 25,
      streamHeartbeatMs: 40,
    });
    const abort = new AbortController();
    try {
      await event(h);
      const head = (await h.inject("/api/stream/head")).json().sequence;
      const base = await start(h);
      const response = await fetch(base + "/api/stream", {
        headers: { "Last-Event-ID": String(head - 1) },
        signal: abort.signal,
      });
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );
      const reader = response.body!.getReader();
      let text = await readUntil(reader, (s) => s.includes("event: change"));
      expect(text).toContain(`id: ${head}`);
      await event(h);
      text += await readUntil(
        reader,
        (s) => s.includes("event: change") && s.includes(": ping"),
      );
      expect(text).toContain(`id: ${head + 1}`);
      expect(h.getStreamCount()).toBe(1);
      abort.abort();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(h.getStreamCount()).toBe(0);
    } finally {
      abort.abort();
      await h.close();
    }
  });
  it("reports expired cursors after pruning", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await event(h);
      await event(h);
      const head = (await h.inject("/api/stream/head")).json().sequence;
      h.pruneChanges(2);
      const base = await start(h);
      const r = await fetch(`${base}/api/stream?after=0`);
      expect(r.status).toBe(409);
      expect((await r.json()).error).toBe("stream_cursor_expired");
      expect((await h.inject("/api/stream/head")).json().sequence).toBe(head);
    } finally {
      await h.close();
    }
  });
  it("fails after three delivery attempts and does not create an Execution for delivery retries", async () => {
    let t = Date.parse("2026-01-01T00:00:00Z"),
      calls = 0;
    const h = createHub(":memory:", defaultConfig, () => t, 0, {
      dispatcherPollMs: 0,
      channels: {
        local: {
          id: "local",
          deliver: async () => {
            calls++;
            throw Error("no");
          },
        },
      },
    });
    try {
      const w = await ask(h);
      for (let i = 0; i < 3; i++) {
        await h.dispatchNotifications();
        t += 5000;
      }
      const n = (await h.inject("/api/notifications")).json();
      expect(n[0].deliveries[0].status).toBe("failed");
      expect(n[0].deliveries[0].attempt).toBe(3);
      expect(calls).toBe(3);
      expect((await details(h, w.id)).executions).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
  it("records final work failure notification but not every retry", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const w = (await event(h)).json().workItem;
      const c = (
        await post(h, "/api/executions/claim", { workerId: "w" })
      ).json();
      await post(h, `/api/executions/${c.execution.id}/result`, {
        workerId: "w",
        leaseToken: c.leaseToken,
        result: {
          type: "failed",
          error: { code: "agent_protocol", message: "bad", retryable: false },
        },
      });
      const n = (await h.inject("/api/notifications")).json();
      expect(n[0].kind).toBe("work_item_failed");
      expect((await details(h, w.id)).workItem.status).toBe("failed");
    } finally {
      await h.close();
    }
  });
  it("sends changes to two clients and resumes using the query cursor after reconnect", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
      streamPollMs: 20,
    });
    const ac = new AbortController(),
      bc = new AbortController();
    try {
      await event(h);
      const head = (await h.inject("/api/stream/head")).json().sequence;
      const base = await start(h);
      const a = await fetch(`${base}/api/stream?after=${head}`, {
        signal: ac.signal,
      });
      const b = await fetch(`${base}/api/stream?after=${head}`, {
        signal: bc.signal,
      });
      const ar = a.body!.getReader(),
        br = b.body!.getReader();
      await event(h);
      const [aa, bb] = await Promise.all([
        readUntil(ar, (s) => s.includes(`id: ${head + 1}`)),
        readUntil(br, (s) => s.includes(`id: ${head + 1}`)),
      ]);
      expect(aa.match(new RegExp(`id: ${head + 1}\\n`, "g"))).toHaveLength(1);
      expect(bb).toContain(`id: ${head + 1}`);
      ac.abort();
      bc.abort();
      const head2 = (await h.inject("/api/stream/head")).json().sequence;
      const cc = new AbortController();
      try {
        const c = await fetch(`${base}/api/stream?after=${head}`, {
          signal: cc.signal,
        });
        const replay = await readUntil(c.body!.getReader(), (s) =>
          s.includes(`id: ${head2}`),
        );
        expect(replay).toContain(`id: ${head + 1}`);
        expect(replay).not.toContain(`id: ${head}\n`);
      } finally {
        cc.abort();
      }
    } finally {
      ac.abort();
      bc.abort();
      await h.close();
    }
  });
  it("migrates a phase 3 database without altering existing work and schedule records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-phase3-"));
    const path = join(dir, "db");
    let h = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const w = await ask(h);
      await post(h, "/api/schedules", {
        kind: "cron",
        expression: "* * * * *",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      await h.close();
      const db = new DatabaseSync(path);
      for (const row of db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'changes_%'",
        )
        .all())
        db.exec(`DROP TRIGGER "${row.name}"`);
      db.exec(
        "DROP TABLE notification_deliveries; DROP TABLE notifications; DROP TABLE runtime_changes; DROP TABLE stream_retention; DELETE FROM schema_migrations WHERE version=3",
      );
      db.close();
      h = createHub(path, defaultConfig, undefined, 0, { dispatcherPollMs: 0 });
      const d = await details(h, w.id);
      expect(d.workItem.status).toBe("waiting_input");
      expect(d.agentSession.externalSessionId).toBe("secret-external");
      expect(d.interactions[0].status).toBe("open");
      expect((await h.inject("/api/schedules")).json()).toHaveLength(1);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("backfills an open phase 3 interaction as a notification during upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-upgrade-notify-"));
    const path = join(dir, "db");
    let h = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const w = await ask(h);
      await h.close();
      const db = new DatabaseSync(path);
      for (const row of db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'changes_%'",
        )
        .all())
        db.exec(`DROP TRIGGER "${row.name}"`);
      db.exec(
        "DROP TABLE notification_deliveries; DROP TABLE notifications; DROP TABLE runtime_changes; DROP TABLE stream_retention; DELETE FROM schema_migrations WHERE version=3",
      );
      db.close();
      h = createHub(path, defaultConfig, undefined, 0, { dispatcherPollMs: 0 });
      expect((await details(h, w.id)).interactions[0].status).toBe("open");
      const notes = (await h.inject("/api/notifications")).json();
      expect(notes).toHaveLength(1);
      expect(notes[0].deliveries[0].status).toBe("queued");
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("signals resync if a live consumer falls behind retention", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 250,
      streamHeartbeatMs: 1000,
    });
    const ctrl = new AbortController();
    try {
      await event(h);
      const head = (await h.inject("/api/stream/head")).json().sequence;
      const base = await start(h);
      const response = await fetch(`${base}/api/stream?after=${head}`, {
        signal: ctrl.signal,
      });
      const reader = response.body!.getReader();
      await readUntil(reader, (s) => s.includes(": connected"));
      await event(h);
      await event(h);
      h.pruneChanges(1);
      const text = await readUntil(reader, (s) => s.includes("event: resync"));
      expect(text).toContain("stream_cursor_expired");
    } finally {
      ctrl.abort();
      await h.close();
    }
  });
  it("keeps a cancelled delivery cancelled if answer races an in-flight channel", async () => {
    let finish: () => void = () => {};
    const delivered = new Promise<void>((r) => {
      finish = r;
    });
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
      channels: {
        local: {
          id: "local",
          deliver: async () => {
            await delivered;
            return { ok: true };
          },
        },
      },
    });
    try {
      await ask(h);
      const pending = h.dispatchNotifications();
      const inbox = (await h.inject("/api/inbox")).json();
      await post(h, `/api/interactions/${inbox[0].interactionId}/answer`, {
        answer: "蓝色",
      });
      finish();
      await pending;
      const n = (await h.inject("/api/notifications")).json();
      expect(n[0].deliveries[0].status).toBe("cancelled");
    } finally {
      finish();
      await h.close();
    }
  });
  it("reclaims an expired claimed delivery after Hub restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-lease-notify-"));
    const path = join(dir, "db");
    let t = Date.parse("2026-01-01T00:00:00Z"),
      calls = 0;
    const channels = {
      local: {
        id: "local",
        deliver: async () => {
          calls++;
          return { ok: true };
        },
      },
    };
    let h = createHub(path, defaultConfig, () => t, 0, {
      dispatcherPollMs: 0,
      channels,
    });
    try {
      await ask(h);
      await h.close();
      const db = new DatabaseSync(path);
      db.prepare(
        "UPDATE notification_deliveries SET status='claimed',attempt=1,claimed_by='dead',lease_token='old',lease_expires_at=?",
      ).run(new Date(t + 30000).toISOString());
      db.close();
      t += 31000;
      h = createHub(path, defaultConfig, () => t, 0, {
        dispatcherPollMs: 0,
        channels,
      });
      await h.dispatchNotifications();
      const n = (await h.inject("/api/notifications")).json();
      expect(n[0].deliveries[0].status).toBe("sent");
      expect(n[0].deliveries[0].attempt).toBe(2);
      expect(calls).toBe(1);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("replays persisted changes after a Hub restart using the last event ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-stream-restart-"));
    const path = join(dir, "db");
    let h = createHub(path, defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const ctrl = new AbortController();
    try {
      await event(h);
      const cursor = (await h.inject("/api/stream/head")).json().sequence;
      await h.close();
      h = createHub(path, defaultConfig, undefined, 0, { dispatcherPollMs: 0 });
      await event(h);
      const base = await start(h);
      const response = await fetch(base + "/api/stream", {
        headers: { "Last-Event-ID": String(cursor) },
        signal: ctrl.signal,
      });
      const text = await readUntil(response.body!.getReader(), (s) =>
        s.includes(`id: ${cursor + 1}`),
      );
      expect(text).not.toContain(`id: ${cursor}\n`);
    } finally {
      ctrl.abort();
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("notifies several independent open interactions oldest first", async () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const h = createHub(":memory:", defaultConfig, () => now, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const a = await ask(h);
      now += 1000;
      const b = await ask(h);
      const inbox = (await h.inject("/api/inbox")).json();
      expect(inbox.map((x: any) => x.workItemId)).toEqual([a.id, b.id]);
      expect((await h.inject("/api/notifications")).json()).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
  it("sends completion notifications only when configured", async () => {
    const config = {
      ...defaultConfig,
      routes: defaultConfig.routes.map((r) =>
        r.event.type === "demo.cron" ? { ...r, notifyOnCompleted: true } : r,
      ),
    };
    const hub = createHub(":memory:", config, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const work = (await event(hub, "demo.cron")).json().workItem;
      const c = (
        await post(hub, "/api/executions/claim", { workerId: "w" })
      ).json();
      await post(hub, `/api/executions/${c.execution.id}/result`, {
        workerId: "w",
        leaseToken: c.leaseToken,
        result: { type: "completed", sessionId: "s", output: "done" },
      });
      expect((await details(hub, work.id)).workItem.status).toBe("completed");
      expect((await hub.inject("/api/notifications")).json()[0].kind).toBe(
        "work_item_completed",
      );
    } finally {
      await hub.close();
    }
  });
  it("closes active SSE connections on Hub shutdown", async () => {
    const hub = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    const base = await start(hub);
    const res = await fetch(base + "/api/stream");
    const reader = res.body!.getReader();
    await readUntil(reader, (s) => s.includes(": connected"));
    await hub.close();
    expect((await reader.read()).done).toBe(true);
  });
  it("rolls back a runtime change when scheduled routing fails inside its transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-change-rollback-"));
    const dbpath = join(dir, "db");
    let t = Date.parse("2026-01-01T00:00:00Z");
    let h = createHub(dbpath, defaultConfig, () => t, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await post(h, "/api/schedules", {
        kind: "once",
        runAt: "2026-01-01T00:00:01Z",
        event: { source: "local", type: "demo.cron", payload: {} },
      });
      const head = (await h.inject("/api/stream/head")).json().sequence;
      await h.close();
      t += 2000;
      h = createHub(
        dbpath,
        {
          ...defaultConfig,
          routes: defaultConfig.routes.filter(
            (r) => r.event.type !== "demo.cron",
          ),
        },
        () => t,
        0,
        { dispatcherPollMs: 0 },
      );
      expect(() => h.tickScheduler()).toThrow();
      expect((await h.inject("/api/stream/head")).json().sequence).toBe(head);
    } finally {
      await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not put external session IDs into notification payloads", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      await ask(h);
      const notes = (await h.inject("/api/notifications")).json();
      expect(JSON.stringify(notes)).not.toContain("secret-external");
    } finally {
      await h.close();
    }
  });
});
