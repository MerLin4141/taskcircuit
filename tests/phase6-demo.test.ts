// Guards the local demo against stopping after one round or changing sessions.
import { it, expect } from "vitest";
import { MockAgentAdapter } from "../src/adapter.js";
it("continues twice and completes using one mock session", async () => {
  const agent = new MockAgentAdapter();
  const base = {
    workItemId: "work",
    executionId: "exec",
    workingDirectory: ".",
    instruction: "",
    context: { type: "demo.loop" },
    previousAnswers: [],
    model: null,
  };
  const first = await agent.execute({
    ...base,
    executionSequence: 1,
    externalSessionId: null,
  });
  expect(first.type).toBe("continue");
  if (first.type !== "continue") return;
  const second = await agent.execute({
    ...base,
    executionSequence: 2,
    externalSessionId: first.sessionId,
  });
  expect(second).toMatchObject({
    type: "continue",
    sessionId: first.sessionId,
  });
  const third = await agent.execute({
    ...base,
    executionSequence: 3,
    externalSessionId: first.sessionId,
  });
  expect(third).toMatchObject({
    type: "completed",
    sessionId: first.sessionId,
  });
});

it("drives the mock demo through the real Hub and Worker", async () => {
  const { setupLoop } = await import("./fixtures/phase5-setup.js");
  const { workOnce } = await import("../src/worker.js");
  const f = await setupLoop();
  try {
    await workOnce(f.base, "fixture-worker");
    const create = await f.hub.inject({
      method: "POST",
      url: "/api/automations",
      payload: {
        id: "demo-loop",
        eventType: "demo.loop",
        agent: "mock-demo",
        workspace: f.config.policyWorkspaces.safe.path,
      },
    });
    expect(create.statusCode).toBe(200);
    const event = await f.hub.inject({
      method: "POST",
      url: "/api/events/v2",
      payload: {
        sourceEventId: "loop",
        type: "demo.loop",
        automationId: "demo-loop",
        payload: {},
      },
    });
    const root = event.json().rootId;
    expect(root).toBeTruthy();
    for (let n = 0; n < 3; n++)
      expect(await workOnce(f.base, "demo-worker")).toBe(true);
    const result = (
      await f.hub.inject({ method: "GET", url: `/api/roots/${root}` })
    ).json();
    expect(result).toMatchObject({ status: "completed", runs: 3 });
    expect(
      f.db
        .prepare("SELECT count(*) n FROM work_items WHERE root_id=?")
        .get(root)?.n,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
