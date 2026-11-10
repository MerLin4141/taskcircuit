// Guards source identity binding, delivery idempotency, and plugin-independent Event Core ingress.
import { describe, expect, it } from "vitest";
import { createHub } from "./fixtures/g2-hub.js";
import { defaultConfig } from "../src/config.js";
import { createHubPluginRegistry } from "../src/plugins/builtin/sources.js";
import { PluginRegistry } from "../src/plugins/registry.js";
import { PluginNotFoundError } from "../src/plugins/errors.js";
import { TaskCircuitError } from "../src/domain.js";

const send = (hub: ReturnType<typeof createHub>, payload: unknown) =>
  hub.inject({ method: "POST", url: "/api/events/v2", payload });

describe("source plugin ingress", () => {
  it("registers local source in independent Hub registries", () => {
    const a = createHubPluginRegistry(),
      b = createHubPluginRegistry();
    expect(a.getSource("local").manifest).toMatchObject({
      id: "local",
      kind: "source",
      apiVersion: 1,
    });
    expect(a.getSource("local")).not.toBe(b.getSource("local"));
    expect(a.listAgents()).toEqual([]);
    expect(a.listChannels()).toEqual([]);
  });
  it("binds local context, ignores spoofed selectors and preserves duplicate/conflict", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const event = {
        sourceEventId: "source-a",
        type: "unknown.example",
        payload: { value: 1 },
        displaySource: "display-only",
        sourceInstance: "forged",
        trustContext: "trusted_internal",
        plugin: "test-source",
        sourcePlugin: "test-source",
      };
      const first = await send(h, event);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        status: "unroutable",
        rootId: null,
      });
      const eventId = first.json().eventId;
      const details = (await h.inject(`/api/events/v2/${eventId}`)).json();
      expect(details.event).toMatchObject({
        sourceInstance: "local-cli",
        trustContext: "trusted_local_cli",
        source: "display-only",
      });
      const replay = await send(h, event);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ status: "duplicate", eventId });
      const conflict = await send(h, { ...event, payload: { value: 2 } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error.code).toBe("event_delivery_conflict");
    } finally {
      await h.close();
    }
  });
  it("routes a test-only trusted source through Hub to Event Core", async () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: {
        id: "test-source",
        kind: "source",
        apiVersion: 1,
        version: "test",
      },
      ingest(input: unknown) {
        const value = input as { message: string };
        return {
          sourceContext: {
            sourceInstance: "fixture-source",
            trustContext: "external_untrusted",
          },
          envelope: {
            sourceEventId: "fixture-1",
            type: "fixture.message",
            payload: { message: value.message },
          },
        };
      },
    });
    const h = createHub(
      ":memory:",
      defaultConfig,
      undefined,
      0,
      { dispatcherPollMs: 0 },
      { registry, sourceId: "test-source" },
    );
    try {
      const result = await send(h, { message: "hello", sourcePlugin: "local" });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        status: "unroutable",
        rootId: null,
      });
      const detail = (
        await h.inject(`/api/events/v2/${result.json().eventId}`)
      ).json();
      expect(detail.event).toMatchObject({
        sourceInstance: "fixture-source",
        trustContext: "external_untrusted",
        payload: { message: "hello" },
      });
    } finally {
      await h.close();
    }
  });
  it("rejects a missing configured source before serving requests", () => {
    expect(() =>
      createHub(
        ":memory:",
        defaultConfig,
        undefined,
        0,
        {},
        { registry: new PluginRegistry(), sourceId: "missing" },
      ),
    ).toThrow(PluginNotFoundError);
  });
  it("keeps loopback and body-shape validation at the HTTP boundary", async () => {
    const h = createHub(":memory:", defaultConfig, undefined, 0, {
      dispatcherPollMs: 0,
    });
    try {
      const remote = await h.inject({
        method: "POST",
        url: "/api/events/v2",
        remoteAddress: "203.0.113.1",
        payload: { sourceEventId: "x", type: "unknown.test", payload: {} },
      });
      expect(remote.statusCode).toBe(403);
      expect((await send(h, ["invalid"])).statusCode).toBe(400);
    } finally {
      await h.close();
    }
  });
  it("returns an existing event error when a trusted source rejects input", async () => {
    const registry = new PluginRegistry();
    registry.register({
      manifest: {
        id: "reject",
        kind: "source",
        apiVersion: 1,
        version: "test",
      },
      ingest() {
        throw new TaskCircuitError("event_invalid", "invalid event", 400);
      },
    });
    const h = createHub(
      ":memory:",
      defaultConfig,
      undefined,
      0,
      { dispatcherPollMs: 0 },
      { registry, sourceId: "reject" },
    );
    try {
      const result = await send(h, { value: "bad" });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe("event_invalid");
      expect((await h.inject("/api/events/v2")).json()).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
