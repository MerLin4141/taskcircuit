// Guards session continuity through human answers and scheduled resumes under Loop Limits.
import { it, expect } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { workOnce } from "../src/worker.js";
it("answers and resumes the same autonomous session before the deadline", async () => {
  const f = await setupLoop(3, 120);
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
      await workOnce(f.base, "w", {
        async execute(input) {
          expect(input.externalSessionId).toBe("fake");
          return { type: "completed", sessionId: "fake", output: "done" };
        },
      }),
    ).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) n FROM agent_sessions").get()?.n).toBe(
      1,
    );
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.status,
    ).toBe("completed");
  } finally {
    await f.close();
  }
});
it("resumes the same autonomous session when Later becomes due", async () => {
  const f = await setupLoop(3, 120);
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
    expect(f.hub.tickScheduler()).toBe(1);
    expect(
      await workOnce(f.base, "w", {
        async execute(input) {
          expect(input.externalSessionId).toBe("fake");
          return { type: "completed", sessionId: "fake", output: "done" };
        },
      }),
    ).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) n FROM agent_sessions").get()?.n).toBe(
      1,
    );
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.status,
    ).toBe("completed");
  } finally {
    await f.close();
  }
});
