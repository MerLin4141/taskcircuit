// Guards the logical control-plane boundary against accidental disclosure to agent processes.
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHub } from "../src/hub.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
import { agentEnvironment } from "../src/agents/environment.js";
import { prompt } from "../src/agents/protocol.js";
import type { AgentExecutionInput } from "../src/adapter.js";
import { CodexAdapter } from "../src/agents/codex/adapter.js";
import { ClaudeAdapter } from "../src/agents/claude/adapter.js";
import type { ProcessSpec } from "../src/agents/process.js";
import { detectCli } from "../src/agents/capability.js";

describe("trusted local security contract", () => {
  it("removes all internal environment keys regardless of case for both providers", () => {
    const env = {
      TASKCIRCUIT_HOME: "state",
      taskcircuit_db: "db",
      TaskCircuit_Database: "db",
      TASKCIRCUIT_DB_PATH: "db",
      taskcircuit_token: "secret",
      PATH: "path",
      USERPROFILE: "user",
    };
    for (const adapter of ["codex", "claude"] as const)
      expect(agentEnvironment(env, adapter)).toEqual({
        PATH: "path",
        USERPROFILE: "user",
      });
  });
  it("keeps identifiers and control-plane paths out of the normal agent prompt", () => {
    const text = prompt({
      workItemId: "private-work-id",
      executionId: "private-execution-id",
      workingDirectory: "ignored-directory",
      instruction: "选择颜色",
      context: { source: "local", type: "demo.color", payload: {} },
      previousAnswers: [],
      externalSessionId: "private-external-id",
    });
    for (const forbidden of [
      "private-work-id",
      "private-execution-id",
      "private-external-id",
      "ignored-directory",
      ".taskcircuit",
      "taskcircuit.db",
      "SQLite",
      "database",
    ])
      expect(text).not.toContain(forbidden);
  });
  it("defaults isolation and rejects unsupported sandboxed execution", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-config-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({ agents: { demo: { adapter: "mock" } }, routes: [] }),
      );
      expect(loadConfig(path).agents.demo.isolation).toBe("trusted-local");
      writeFileSync(
        path,
        JSON.stringify({
          agents: { demo: { adapter: "mock", isolation: "sandboxed" } },
          routes: [],
        }),
      );
      expect(() => loadConfig(path)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("passes only execution data to an adapter and uses a workspace outside state root", async () => {
    const root = mkdtempSync(join(tmpdir(), "tc-boundary-"));
    const state = join(root, "state");
    const workspaceRoot = join(root, "workspace");
    const oldHome = process.env.TASKCIRCUIT_HOME;
    const oldWorkspace = process.env.TASKCIRCUIT_WORKSPACE_ROOT;
    process.env.TASKCIRCUIT_HOME = state;
    process.env.TASKCIRCUIT_WORKSPACE_ROOT = workspaceRoot;
    const hub = createHub(":memory:", defaultConfig);
    try {
      await hub.listen({ port: 0, host: "127.0.0.1" });
      const addr = hub.server.address();
      if (!addr || typeof addr === "string") throw new Error("port");
      const base = `http://127.0.0.1:${addr.port}`;
      await hub.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          source: "local",
          type: "demo.mock.color",
          payload: { topic: "color" },
        },
      });
      let captured: AgentExecutionInput | undefined;
      await workOnce(base, "security-test", {
        execute: async (i) => {
          captured = i;
          return {
            type: "completed",
            sessionId: "mock-external",
            output: "ok",
          };
        },
      });
      expect(captured).toBeDefined();
      expect(Object.keys(captured!).sort()).toEqual(
        [
          "context",
          "executionId",
          "externalSessionId",
          "instruction",
          "model",
          "previousAnswers",
          "workItemId",
          "workingDirectory",
        ].sort(),
      );
      expect(captured!.workingDirectory.startsWith(workspaceRoot)).toBe(true);
      expect(captured!.workingDirectory.startsWith(state)).toBe(false);
      expect(JSON.stringify(captured)).not.toContain(state);
      expect(captured!.context).toEqual({
        source: "local",
        type: "demo.mock.color",
        payload: { topic: "color" },
      });
    } finally {
      await hub.close();
      if (oldHome === undefined) delete process.env.TASKCIRCUIT_HOME;
      else process.env.TASKCIRCUIT_HOME = oldHome;
      if (oldWorkspace === undefined)
        delete process.env.TASKCIRCUIT_WORKSPACE_ROOT;
      else process.env.TASKCIRCUIT_WORKSPACE_ROOT = oldWorkspace;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(["codex", "claude"] as const)(
    "%s sends only the separate workspace and filtered environment to its child",
    async (kind) => {
      const prior = process.env.TASKCIRCUIT_DB_PATH;
      process.env.TASKCIRCUIT_DB_PATH = "sensitive-control-path";
      let observed: ProcessSpec | undefined;
      const runner = {
        run: async (spec: ProcessSpec) => {
          observed = spec;
          const content = JSON.stringify({ kind: "complete", message: "ok" });
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              kind === "codex"
                ? JSON.stringify({
                    type: "thread.started",
                    thread_id: "external",
                  }) +
                  "\n" +
                  JSON.stringify({
                    type: "item.completed",
                    item: { type: "agent_message", text: content },
                  })
                : JSON.stringify({ session_id: "external", result: content }),
          };
        },
      };
      try {
        const adapter =
          kind === "codex"
            ? new CodexAdapter(runner, { executable: "fake", prefix: [] })
            : new ClaudeAdapter(runner, { executable: "fake", prefix: [] });
        await adapter.execute({
          workItemId: "internal-work",
          executionId: "internal-execution",
          workingDirectory: join(tmpdir(), "agent-workspace"),
          instruction: "选择颜色",
          context: { payload: {} },
          previousAnswers: [],
          externalSessionId: null,
        });
        expect(observed?.cwd).toBe(join(tmpdir(), "agent-workspace"));
        expect(observed?.env.TASKCIRCUIT_DB_PATH).toBeUndefined();
        expect(JSON.stringify(observed)).not.toContain(
          "sensitive-control-path",
        );
        expect(observed?.stdin).not.toContain("internal-work");
        expect(observed?.stdin).not.toContain("internal-execution");
      } finally {
        if (prior === undefined) delete process.env.TASKCIRCUIT_DB_PATH;
        else process.env.TASKCIRCUIT_DB_PATH = prior;
      }
    },
  );
  it("filters internal variables during CLI capability probing", async () => {
    const previous = process.env.TASKCIRCUIT_HOME;
    process.env.TASKCIRCUIT_HOME = "private-control-root";
    let env: NodeJS.ProcessEnv | undefined;
    try {
      const runner = {
        run: async (spec: ProcessSpec) => {
          env = spec.env;
          return { exitCode: 0, stdout: "resume --json", stderr: "" };
        },
      };
      expect(
        await detectCli("codex", runner, ".", {
          executable: "fake",
          prefix: [],
        }),
      ).toBe(true);
      expect(env?.TASKCIRCUIT_HOME).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.TASKCIRCUIT_HOME;
      else process.env.TASKCIRCUIT_HOME = previous;
    }
  });
  it("does not import SQLite implementation from worker or agent modules", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(dir, entry.name))
          : [join(dir, entry.name)],
      );
    for (const path of [
      "src/worker.ts",
      "src/adapter.ts",
      ...walk("src/agents"),
    ]) {
      const text = readFileSync(path, "utf8");
      expect(text).not.toMatch(
        /(?:node:sqlite|\.\.\/.*(?:storage|migration|hub))/,
      );
    }
  });
});
