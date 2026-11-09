// Guards Root summaries against leaking execution credentials or hiding terminal reasons.
import { expect, it } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";

it("lists and shows a Root with bounded loop information without internal secrets", async () => {
  const f = await setupLoop(3, 120);
  try {
    const list = await f.hub.inject({ method: "GET", url: "/api/roots" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.ev.rootId,
          automation: "Auto",
          maxRuns: 3,
        }),
      ]),
    );
    const detail = await f.hub.inject({
      method: "GET",
      url: `/api/roots/${f.ev.rootId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: f.ev.rootId,
      automation: "Auto",
      maxRuns: 3,
    });
    expect(detail.body).not.toMatch(
      /leaseToken|externalSessionId|submissionId|resultDigest/,
    );
    expect(
      (await f.hub.inject({ method: "GET", url: "/api/roots/missing" }))
        .statusCode,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

it("reports schema and registered profiles without exposing credentials", async () => {
  const f = await setupLoop();
  try {
    const reply = await f.hub.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      schema: 10,
      agentProfiles: expect.arrayContaining(["demo-agent"]),
    });
    expect(reply.body).not.toMatch(/leaseToken|password|secret|credential/i);
  } finally {
    await f.close();
  }
});
