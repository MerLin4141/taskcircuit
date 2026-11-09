// Guards Root limits against later Definition changes and untrusted Event timestamps.
import { it, expect } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { addDefinitionVersion } from "../src/automation-domain.js";
it("pins old Root limits while a new Definition version applies only to new Roots", async () => {
  const f = await setupLoop(3, 120);
  try {
    const original = f.db
      .prepare(
        "SELECT max_runs,deadline_at,definition_version FROM automation_roots WHERE id=?",
      )
      .get(f.ev.rootId);
    const current = f.db
      .prepare(
        "SELECT config_snapshot_json FROM automation_definition_versions WHERE definition_id='a' AND version=1",
      )
      .get()!;
    const next = JSON.parse(String(current.config_snapshot_json));
    next.loop = { maxRuns: 5, maxDurationSeconds: 240 };
    addDefinitionVersion(f.db, "a", 2, next, "2026-01-01T00:00:00Z");
    const event = await f.hub.inject({
      method: "POST",
      url: "/api/events/v2",
      payload: {
        sourceEventId: "new",
        type: "demo.color",
        automationId: "a",
        correlationKey: "second",
        occurredAt: "2025-01-01T00:00:00Z",
        payload: { maxRuns: 999, deadline: "never" },
      },
    });
    expect(event.statusCode).toBe(200);
    const rootId = event.json().rootId;
    expect(
      f.db
        .prepare(
          "SELECT max_runs,deadline_at,definition_version FROM automation_roots WHERE id=?",
        )
        .get(f.ev.rootId),
    ).toEqual(original);
    expect(
      f.db
        .prepare(
          "SELECT max_runs,deadline_at,definition_version FROM automation_roots WHERE id=?",
        )
        .get(rootId),
    ).toMatchObject({
      max_runs: 5,
      deadline_at: "2026-01-01T00:04:00.000Z",
      definition_version: 2,
    });
  } finally {
    await f.close();
  }
});

it("rejects Agent feedback that tries to change the frozen limits or workspace", async () => {
  const f = await setupLoop(3, 120);
  try {
    const before = f.db
      .prepare("SELECT max_runs,deadline_at FROM automation_roots WHERE id=?")
      .get(f.ev.rootId);
    const claim = await f.hub.inject({
      method: "POST",
      url: "/api/executions/claim",
      payload: { workerId: "w" },
    });
    expect(claim.statusCode).toBe(200);
    const c = claim.json();
    const response = await f.hub.inject({
      method: "POST",
      url: `/api/executions/${c.execution.id}/result`,
      payload: {
        workerId: "w",
        leaseToken: c.leaseToken,
        result: {
          type: "continue",
          sessionId: "fake",
          message: "next",
          maxRuns: 999,
          deadline: "never",
          workspace: "C:/",
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(
      f.db
        .prepare("SELECT max_runs,deadline_at FROM automation_roots WHERE id=?")
        .get(f.ev.rootId),
    ).toEqual(before);
  } finally {
    await f.close();
  }
});
