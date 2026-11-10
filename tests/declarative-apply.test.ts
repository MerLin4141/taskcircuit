// Guards declarative ownership, atomic apply, version pinning and trusted runtime boundaries.
import { describe, expect, it } from "vitest";
import { setupLoop } from "./fixtures/phase5-setup.js";
import { applyDocument } from "../src/declarative.js";
import { loadConfig } from "../src/config.js";
import { ingestEvent } from "../src/event-core.js";
import { evaluateDecision } from "../src/decision-core.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const doc = (instruction = "first") => ({
  schemaVersion: 1,
  id: "project-a",
  rules: [
    {
      name: "managed",
      when: { source: "local", type: "demo.color" },
      agent: "demo-agent",
      workspace: "safe",
      instruction,
      loop: { maxRuns: 8, deadline: "2h" },
      notify: ["local"],
      notifyOnCompleted: true,
    },
  ],
});
const post = (
  h: ReturnType<typeof setupLoop> extends Promise<infer F>
    ? F extends { hub: infer H }
      ? H
      : never
    : never,
  url: string,
  payload: unknown,
) => (h as any).inject({ method: "POST", url, payload });

describe("declarative apply", () => {
  it("creates, is idempotent, versions changed rules, and pins old Roots", async () => {
    const f = await setupLoop();
    try {
      const first = (
        await post(f.hub, "/api/automations/apply", {
          document: doc(),
          dryRun: false,
        })
      ).json();
      expect(first.changes[0]).toMatchObject({
        automation: "managed",
        action: "create",
        toVersion: 1,
      });
      const same = (
        await post(f.hub, "/api/automations/apply", {
          document: doc(),
          dryRun: false,
        })
      ).json();
      expect(same.changes[0].action).toBe("unchanged");
      const event1 = (
        await post(f.hub, "/api/events/v2", {
          sourceEventId: "phase6-1",
          type: "demo.color",
          automationId: "managed",
          payload: { agent: "evil", workspace: "evil", maxRuns: 999 },
        })
      ).json();
      expect(
        f.db
          .prepare("SELECT definition_version FROM automation_roots WHERE id=?")
          .get(event1.rootId)?.definition_version,
      ).toBe(1);
      expect(
        f.db
          .prepare("SELECT max_runs FROM automation_roots WHERE id=?")
          .get(event1.rootId)?.max_runs,
      ).toBe(8);
      const update = (
        await post(f.hub, "/api/automations/apply", {
          document: doc("second"),
          dryRun: false,
        })
      ).json();
      expect(update.changes[0]).toMatchObject({
        action: "version",
        fromVersion: 1,
        toVersion: 2,
      });
      const event2 = (
        await post(f.hub, "/api/events/v2", {
          sourceEventId: "phase6-2",
          type: "demo.color",
          automationId: "managed",
          payload: {},
        })
      ).json();
      expect(
        f.db
          .prepare("SELECT definition_version FROM automation_roots WHERE id=?")
          .get(event1.rootId)?.definition_version,
      ).toBe(1);
      expect(
        f.db
          .prepare("SELECT definition_version FROM automation_roots WHERE id=?")
          .get(event2.rootId)?.definition_version,
      ).toBe(2);
      expect(
        f.db
          .prepare(
            "SELECT COUNT(*) AS n FROM automation_definition_versions WHERE definition_id='managed'",
          )
          .get()?.n,
      ).toBe(2);
      const again = (
        await post(f.hub, "/api/automations/apply", {
          document: doc("second"),
          dryRun: false,
        })
      ).json();
      expect(again.changes[0].action).toBe("unchanged");
      const work = f.db
        .prepare(
          "SELECT metadata,agent_profile_id FROM work_items WHERE root_id=?",
        )
        .get(event1.rootId)!;
      expect(
        f.db
          .prepare("SELECT name FROM agent_profiles WHERE id=?")
          .get(String(work.agent_profile_id))?.name,
      ).toBe("demo-agent");
      expect(JSON.parse(String(work.metadata))).toMatchObject({
        instruction: "first",
        notify: ["local"],
        notifyOnCompleted: true,
      });
    } finally {
      await f.close();
    }
  });
  it("dry-run writes nothing, manual and cross-document conflicts block the whole plan", async () => {
    const f = await setupLoop();
    try {
      const payload = doc();
      const dry = (
        await post(f.hub, "/api/automations/apply", {
          document: payload,
          dryRun: true,
        })
      ).json();
      expect(dry.changes[0].action).toBe("create");
      expect(
        f.db
          .prepare("SELECT id FROM automation_definitions WHERE id='managed'")
          .get(),
      ).toBeUndefined();
      await post(f.hub, "/api/automations/apply", {
        document: payload,
        dryRun: false,
      });
      const other = {
        ...doc(),
        id: "project-b",
        rules: [{ ...doc().rules[0], name: "new-one" }, doc().rules[0]],
      };
      const plan = (
        await post(f.hub, "/api/automations/apply", {
          document: other,
          dryRun: false,
        })
      ).json();
      expect(plan.changes.map((x: any) => x.action)).toContain("conflict");
      expect(
        f.db
          .prepare("SELECT id FROM automation_definitions WHERE id='new-one'")
          .get(),
      ).toBeUndefined();
      const manual = await post(f.hub, "/api/automations", {
        id: "manual",
        eventType: "demo.color",
        agent: "demo-agent",
        workspace: f.config.policyWorkspaces.safe.path,
      });
      expect(manual.statusCode).toBe(200);
      const conflict = (
        await post(f.hub, "/api/automations/apply", {
          document: {
            ...doc(),
            rules: [{ ...doc().rules[0], name: "manual" }],
          },
          dryRun: false,
        })
      ).json();
      expect(conflict.changes[0].action).toBe("conflict");
    } finally {
      await f.close();
    }
  });
  it("rolls back all writes after an injected failure", async () => {
    const f = await setupLoop();
    try {
      const many = {
        ...doc(),
        rules: [
          { ...doc().rules[0], name: "first" },
          { ...doc().rules[0], name: "second" },
        ],
      };
      expect(() =>
        applyDocument(
          f.db,
          f.config,
          many,
          false,
          () => Date.now(),
          () => {
            throw Error("injected");
          },
        ),
      ).toThrow("injected");
      expect(
        f.db
          .prepare(
            "SELECT id FROM automation_definitions WHERE id IN ('first','second')",
          )
          .all(),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("rejects invalid rules and untrusted profiles, sources, workspaces and channels", async () => {
    const f = await setupLoop();
    try {
      const base = doc();
      const invalid = [
        { ...base, schemaVersion: 2 },
        { ...base, id: "" },
        { ...base, rules: [base.rules[0], base.rules[0]] },
        ...(
          [
            { agent: "unknown" },
            { workspace: "unknown" },
            { notify: ["unknown"] },
            { when: { source: "other", type: "demo.color" } },
            { loop: { maxRuns: 0, deadline: "2h" } },
            { loop: { maxRuns: null, deadline: "2h" } },
            { loop: { maxRuns: 8, deadline: "invalid" } },
            { module: "./bad.mjs" },
          ] as object[]
        ).map((x) => ({ ...base, rules: [{ ...base.rules[0], ...x }] })),
      ];
      for (const value of invalid) {
        const response = await post(f.hub, "/api/automations/apply", {
          document: value,
          dryRun: false,
        });
        expect(response.statusCode).toBe(400);
      }
      expect(
        f.db
          .prepare("SELECT id FROM automation_definitions WHERE id='managed'")
          .get(),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it("rejects ambiguous trusted routes before applying", async () => {
    const f = await setupLoop();
    try {
      const config = {
        ...f.config,
        routes: [
          ...f.config.routes,
          {
            ...f.config.routes.find((r) => r.event.type === "demo.color")!,
            id: "duplicate",
          },
        ],
      };
      const plan = applyDocument(f.db, config, doc(), false, () => Date.now());
      expect(plan.changes[0].action).toBe("invalid");
      expect(
        f.db
          .prepare("SELECT id FROM automation_definitions WHERE id='managed'")
          .get(),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it("keeps canonical reapply stable across field order and rejects remote apply", async () => {
    const f = await setupLoop();
    try {
      await post(f.hub, "/api/automations/apply", {
        document: doc(),
        dryRun: false,
      });
      const reordered = {
        rules: [
          {
            loop: { deadline: "2h", maxRuns: 8 },
            instruction: "first",
            workspace: "safe",
            agent: "demo-agent",
            when: { type: "demo.color", source: "local" },
            name: "managed",
            notifyOnCompleted: true,
            notify: ["local"],
          },
        ],
        id: "project-a",
        schemaVersion: 1,
      };
      const plan = (
        await post(f.hub, "/api/automations/apply", {
          document: reordered,
          dryRun: false,
        })
      ).json();
      expect(plan.changes[0].action).toBe("unchanged");
      const remote = await f.hub.inject({
        method: "POST",
        url: "/api/automations/apply",
        remoteAddress: "203.0.113.1",
        payload: { document: doc(), dryRun: false },
      });
      expect(remote.statusCode).toBe(403);
    } finally {
      await f.close();
    }
  });
  it("reports the complete invalid plan and performs no partial writes", async () => {
    const f = await setupLoop();
    try {
      const input = {
        ...doc(),
        rules: [
          { ...doc().rules[0], name: "valid-rule" },
          { ...doc().rules[0], name: "invalid-rule", workspace: "missing" },
        ],
      };
      const response = await post(f.hub, "/api/automations/apply", {
        document: input,
        dryRun: false,
      });
      expect(response.statusCode).toBe(400);
      expect(
        response.json().changes.map((c: any) => [c.automation, c.action]),
      ).toEqual([
        ["invalid-rule", "invalid"],
        ["valid-rule", "create"],
      ]);
      expect(
        f.db
          .prepare(
            "SELECT id FROM automation_definitions WHERE id='valid-rule'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it("does not authorize another Source even if it names the same Automation", async () => {
    const f = await setupLoop();
    try {
      await post(f.hub, "/api/automations/apply", {
        document: doc(),
        dryRun: false,
      });
      const event = ingestEvent(
        f.db,
        { sourceInstance: "foreign", trustContext: "external_untrusted" },
        {
          sourceEventId: "foreign-1",
          type: "demo.color",
          automationId: "managed",
          payload: {
            sourceInstance: "local-cli",
            trustContext: "trusted_local_cli",
          },
        },
        { knownTypes: new Set(["demo.color"]), now: () => Date.now() },
      );
      const decision = evaluateDecision(
        f.db,
        {
          requestId: "foreign-decision",
          eventId: event.eventId,
          rootId: event.rootId!,
          generation: 1,
        },
        { config: f.config, now: () => Date.now() },
      );
      expect(decision.decision).toMatchObject({
        type: "block",
        reasonCode: "event_source_mismatch",
      });
      expect(
        f.db
          .prepare("SELECT id FROM work_items WHERE root_id=?")
          .get(event.rootId!),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });
  it("preserves missing rules and accepts declared external Agent profiles", async () => {
    const f = await setupLoop();
    try {
      const config = {
        ...f.config,
        agents: { ...f.config.agents, external: { adapter: "external-agent" } },
        plugins: {
          worker: [
            {
              id: "external-agent",
              kind: "agent",
              module: "./fixture-agent.mjs",
            },
          ],
        },
        routes: [
          ...f.config.routes,
          {
            id: "external-route",
            event: { source: "local", type: "external.job" },
            agent: "external",
            title: "external",
          },
        ],
      };
      const rules = {
        ...doc(),
        rules: [
          {
            ...doc().rules[0],
            name: "external-rule",
            agent: "external",
            when: { source: "local", type: "external.job" },
          },
        ],
      };
      const configPath = join(f.home, "taskcircuit.config.json");
      writeFileSync(configPath, JSON.stringify(config));
      const trustedConfig = loadConfig(configPath);
      expect(
        applyDocument(f.db, trustedConfig, rules, false, () => Date.now())
          .changes[0].action,
      ).toBe("create");
      expect(
        applyDocument(f.db, config, { ...rules, rules: [] }, false, () =>
          Date.now(),
        ).changes,
      ).toEqual([]);
      expect(
        f.db
          .prepare(
            "SELECT id FROM automation_definitions WHERE id='external-rule'",
          )
          .get(),
      ).toBeTruthy();
    } finally {
      await f.close();
    }
  });
  it("renders human and JSON dry-run using the CLI without writing", async () => {
    const f = await setupLoop();
    try {
      const path = join(f.home, "rules.json");
      writeFileSync(path, JSON.stringify(doc()));
      const run = promisify(execFile);
      const opts = {
        env: { ...process.env, TASKCIRCUIT_PORT: new URL(f.base).port },
        windowsHide: true,
      };
      const human = await run(
        process.execPath,
        ["dist/cli.js", "apply", path, "--dry-run"],
        opts,
      );
      expect(human.stdout).toContain("DRY RUN");
      expect(human.stdout).toContain("managed");
      const json = await run(
        process.execPath,
        ["dist/cli.js", "apply", path, "--dry-run", "--json"],
        opts,
      );
      expect(JSON.parse(json.stdout).changes[0].action).toBe("create");
      expect(
        f.db
          .prepare("SELECT id FROM automation_definitions WHERE id='managed'")
          .get(),
      ).toBeUndefined();
      const applied = await run(
        process.execPath,
        ["dist/cli.js", "apply", path, "--json"],
        opts,
      );
      expect(JSON.parse(applied.stdout).changes[0].action).toBe("create");
      const again = await run(
        process.execPath,
        ["dist/cli.js", "apply", path, "--json"],
        opts,
      );
      expect(JSON.parse(again.stdout).changes[0].action).toBe("unchanged");
      const invalidPath = join(f.home, "invalid-rules.json");
      writeFileSync(
        invalidPath,
        JSON.stringify({
          ...doc(),
          rules: [
            { ...doc().rules[0], name: "bad-rule", workspace: "missing" },
          ],
        }),
      );
      try {
        await run(
          process.execPath,
          ["dist/cli.js", "apply", invalidPath, "--json"],
          opts,
        );
        expect.fail("invalid plan accepted");
      } catch (error) {
        const failure = error as { code: number; stdout: string };
        expect(failure.code).toBe(1);
        expect(JSON.parse(failure.stdout).changes[0].action).toBe("invalid");
      }
    } finally {
      await f.close();
    }
  }, 30000);
});
