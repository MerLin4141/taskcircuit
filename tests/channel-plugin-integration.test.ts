// Guards plugin/instance identity and durable notification delivery through the Hub registry.
import { describe, expect, it, vi } from "vitest";
import { createHub } from "./fixtures/g2-hub.js";
import { defaultConfig, type Config } from "../src/config.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import {
  PluginApiVersionError,
  PluginNotFoundError,
  PluginRegistrationError,
} from "../src/plugins/errors.js";

const ask = async (h: ReturnType<typeof createHub>) => {
  const w = (
    await h.inject({
      method: "POST",
      url: "/api/events",
      payload: {
        source: "local",
        type: "demo.color",
        payload: { plugin: "untrusted", channel: "other" },
      },
    })
  ).json().workItem;
  const c = (
    await h.inject({
      method: "POST",
      url: "/api/executions/claim",
      payload: { workerId: "w" },
    })
  ).json();
  const result = await h.inject({
    method: "POST",
    url: `/api/executions/${c.execution.id}/result`,
    payload: {
      workerId: "w",
      leaseToken: c.leaseToken,
      result: {
        type: "needs_input",
        sessionId: "fixture",
        request: {
          title: "question",
          text: "choose",
          options: ["yes"],
          key: "q",
        },
      },
    },
  });
  expect(result.statusCode).toBe(200);
  return w;
};

describe("Channel Plugin integration", () => {
  it("registers local-console through the Hub registry and preserves instance identity", () => {
    const r = createHubPluginRegistry();
    const plugin = r.getChannel("local-console");
    expect(plugin.manifest).toMatchObject({
      id: "local-console",
      kind: "channel",
      apiVersion: 1,
    });
    const a = plugin.createChannel({ id: "a" });
    const b = plugin.createChannel({ id: "b" });
    expect(a.id).toBe("a");
    expect(b.id).toBe("b");
    expect(a).not.toBe(b);
    expect(() => r.register(plugin)).toThrow(PluginRegistrationError);
    expect(() =>
      r.register({
        ...plugin,
        manifest: { ...plugin.manifest, id: "bad", apiVersion: 2 },
      }),
    ).toThrow(PluginApiVersionError);
    expect(() => r.getChannel("missing")).toThrow(PluginNotFoundError);
  });
  it("fails at startup when a trusted configured channel plugin is unknown", () => {
    const config = {
      ...defaultConfig,
      channels: { local: { type: "missing" } },
    } as unknown as Config;
    expect(() =>
      createHub(":memory:", config, undefined, 0, { dispatcherPollMs: 0 }),
    ).toThrow(PluginNotFoundError);
  });
  it("creates two configured instances of a test plugin and dispatches to both", async () => {
    const registry = createHubPluginRegistry();
    const created: string[] = [],
      delivered: string[] = [];
    registry.register({
      manifest: {
        id: "test-channel",
        kind: "channel",
        apiVersion: 1,
        version: "test",
      },
      createChannel({ id }) {
        created.push(id);
        return {
          id,
          async deliver(input) {
            delivered.push(`${id}:${input.kind}`);
            return { ok: true };
          },
        };
      },
    });
    const config = {
      ...defaultConfig,
      channels: {
        "test-alerts": { type: "test-channel" },
        backup: { type: "test-channel" },
      },
    } as unknown as Config;
    const h = createHub(
      ":memory:",
      config,
      undefined,
      0,
      { dispatcherPollMs: 0 },
      { registry, sourceId: "local" },
    );
    try {
      expect(created).toEqual(["test-alerts", "backup"]);
      await ask(h);
      await h.dispatchNotifications();
      await h.dispatchNotifications();
      const notes = (await h.inject("/api/notifications")).json();
      expect(
        notes[0].deliveries.map((d: any) => [d.channelId, d.status]).sort(),
      ).toEqual([
        ["backup", "sent"],
        ["test-alerts", "sent"],
      ]);
      expect(delivered.sort()).toEqual([
        "backup:interaction_required",
        "test-alerts:interaction_required",
      ]);
    } finally {
      await h.close();
    }
  });
  it("retries a failed plugin delivery after the existing five-second delay", async () => {
    const registry = createHubPluginRegistry();
    let calls = 0;
    let now = Date.parse("2026-01-01T00:00:00Z");
    registry.register({
      manifest: {
        id: "test-channel",
        kind: "channel",
        apiVersion: 1,
        version: "test",
      },
      createChannel({ id }) {
        return {
          id,
          async deliver() {
            calls++;
            return { ok: calls > 1 };
          },
        };
      },
    });
    const config = {
      ...defaultConfig,
      channels: { "test-alerts": { type: "test-channel" } },
    } as unknown as Config;
    const h = createHub(
      ":memory:",
      config,
      () => now,
      0,
      { dispatcherPollMs: 0 },
      { registry, sourceId: "local" },
    );
    try {
      await ask(h);
      await h.dispatchNotifications();
      let delivery = (await h.inject("/api/notifications")).json()[0]
        .deliveries[0];
      expect(delivery).toMatchObject({
        channelId: "test-alerts",
        status: "queued",
        attempt: 1,
      });
      await h.dispatchNotifications();
      expect(calls).toBe(1);
      now += 5000;
      await h.dispatchNotifications();
      delivery = (await h.inject("/api/notifications")).json()[0].deliveries[0];
      expect(delivery).toMatchObject({ status: "sent", attempt: 2 });
    } finally {
      await h.close();
    }
  });
  it("continues to accept directly injected channel instances", async () => {
    const deliver = vi.fn(async () => ({ ok: true }));
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
      channels: { local: { id: "local", deliver } },
    });
    try {
      await ask(h);
      await h.dispatchNotifications();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(
        (await h.inject("/api/notifications")).json()[0].deliveries[0].status,
      ).toBe("sent");
    } finally {
      await h.close();
    }
  });
});
