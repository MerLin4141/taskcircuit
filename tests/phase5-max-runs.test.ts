import { AgentError } from "../src/agents/errors.js";
// Guards finite automatic loops against extra Agent invocations, including exhaustion after Continue.
import { it, expect } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { workOnce } from "../src/worker.js";
it.each([1, 3, 5])(
  "stops an always-Continue fake Agent after exactly %i runs",
  async (maxRuns) => {
    const f = await setupLoop(maxRuns, 120);
    try {
      let calls = 0;
      const adapter = {
        async execute() {
          calls++;
          return {
            type: "continue" as const,
            sessionId: "fake",
            message: "next",
          };
        },
      };
      for (let i = 0; i < maxRuns; i++)
        expect(await workOnce(f.base, "worker", adapter)).toBe(true);
      expect(await workOnce(f.base, "worker", adapter)).toBe(false);
      expect(calls).toBe(maxRuns);
      expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
        maxRuns,
      );
      const root = f.db
        .prepare(
          "SELECT status,terminal_reason FROM automation_roots WHERE id=?",
        )
        .get(f.ev.rootId);
      expect(root).toMatchObject({
        status: "budget_exhausted",
        terminal_reason: "loop_max_runs_reached",
      });
      expect(
        f.db
          .prepare("SELECT status FROM work_items WHERE root_id=?")
          .get(f.ev.rootId)?.status,
      ).toBe("failed");
    } finally {
      await f.close();
    }
  },
);

it("does not retry or continue an unknown Agent outcome", async () => {
  const f = await setupLoop(3, 120);
  try {
    let calls = 0;
    const adapter = {
      async execute() {
        calls++;
        throw new AgentError("agent_timeout", "timeout", false, true);
      },
    };
    expect(await workOnce(f.base, "worker", adapter)).toBe(true);
    expect(await workOnce(f.base, "worker", adapter)).toBe(false);
    expect(calls).toBe(1);
    const e = f.db.prepare("SELECT status,error FROM executions").get()!;
    expect(e.status).toBe("failed");
    expect(JSON.parse(String(e.error)).code).toBe("execution_outcome_unknown");
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.status,
    ).toBe("blocked");
  } finally {
    await f.close();
  }
});

it("processes 100 sequential fake Continue results without manual continuation creation", async () => {
  const f = await setupLoop(101, 120);
  try {
    let calls = 0;
    const adapter = {
      async execute() {
        calls++;
        return calls <= 100
          ? { type: "continue" as const, sessionId: "fake", message: "next" }
          : { type: "completed" as const, sessionId: "fake", output: "done" };
      },
    };
    while (calls < 101)
      expect(await workOnce(f.base, "worker", adapter)).toBe(true);
    expect(f.db.prepare("SELECT COUNT(*) n FROM executions").get()?.n).toBe(
      101,
    );
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.status,
    ).toBe("completed");
  } finally {
    await f.close();
  }
}, 30000);

it("allows a proven pre-start failure to retry without consuming the only run", async () => {
  const f = await setupLoop(1, 120, {
    maxAttempts: 2,
    strategy: "fixed",
    initialDelaySeconds: 1,
    maxDelaySeconds: 1,
  });
  try {
    let calls = 0;
    const adapter = {
      async execute() {
        calls++;
        if (calls === 1)
          throw new AgentError(
            "agent_execution",
            "not started",
            true,
            false,
            true,
          );
        return {
          type: "completed" as const,
          sessionId: "fake",
          output: "done",
        };
      },
    };
    expect(await workOnce(f.base, "w", adapter)).toBe(true);
    f.advance(1000);
    expect(f.hub.tickScheduler()).toBe(1);
    expect(await workOnce(f.base, "w", adapter)).toBe(true);
    expect(calls).toBe(2);
    expect(
      f.db
        .prepare("SELECT status FROM automation_roots WHERE id=?")
        .get(f.ev.rootId)?.status,
    ).toBe("completed");
  } finally {
    await f.close();
  }
});
