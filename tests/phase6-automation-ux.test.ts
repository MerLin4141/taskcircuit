// Guards the CLI-facing creation path from bypassing configured workspace and agent trust.
import { expect, it } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
it("creates and lists an automation only for an explicitly configured workspace and route", async () => {
  const f = await setupLoop();
  try {
    const data = {
      id: "demo",
      eventType: "demo.color",
      agent: "demo-agent",
      workspace: f.config.policyWorkspaces.safe.path,
      instruction: "demo",
    };
    const bad = await f.hub.inject({
      method: "POST",
      url: "/api/automations",
      payload: { ...data, workspace: f.home },
    });
    expect(bad.statusCode).toBe(400);
    const good = await f.hub.inject({
      method: "POST",
      url: "/api/automations",
      payload: data,
    });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toMatchObject({
      id: "demo",
      maxRuns: 8,
      maxDurationSeconds: 7200,
    });
    expect(
      (
        await f.hub.inject({ method: "GET", url: "/api/automations/demo" })
      ).json(),
    ).toMatchObject({ id: "demo", eventType: "demo.color" });
    expect(
      (await f.hub.inject({ method: "GET", url: "/api/automations" })).json(),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "demo" })]),
    );
    await f.restart();
    const ev = await f.hub.inject({
      method: "POST",
      url: "/api/events/v2",
      payload: {
        sourceEventId: "new",
        type: "demo.color",
        automationId: "demo",
        payload: {},
      },
    });
    expect(ev.json()).toMatchObject({ status: "accepted" });
    expect(ev.json().rootId).toBeTruthy();
  } finally {
    await f.close();
  }
});

it("exposes human and JSON automation and Root commands through the CLI", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const f = await setupLoop();
  try {
    const run = promisify(execFile);
    const cli = async (...args: string[]) =>
      (
        await run(process.execPath, ["dist/cli.js", ...args], {
          env: { ...process.env, TASKCIRCUIT_PORT: new URL(f.base).port },
          windowsHide: true,
        })
      ).stdout;
    const created = JSON.parse(
      await cli(
        "automation",
        "create",
        "sample",
        "--event",
        "demo.color",
        "--agent",
        "demo-agent",
        "--workspace",
        f.config.policyWorkspaces.safe.path,
        "--json",
      ),
    );
    expect(created).toMatchObject({
      id: "sample",
      maxRuns: 8,
      maxDurationSeconds: 7200,
    });
    expect(await cli("automation", "list")).toContain("sample");
    expect(await cli("automation", "show", "sample")).toContain("8");
    const roots = JSON.parse(await cli("root", "list", "--json"));
    expect(roots.some((r: any) => r.id === f.ev.rootId)).toBe(true);
    expect(await cli("root", "show", f.ev.rootId)).toContain("运行:");
  } finally {
    await f.close();
  }
}, 30000);
