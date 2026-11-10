import { mkdirSync } from "node:fs";
import {
  MockAgentAdapter,
  type AgentAdapter,
  type AgentExecutionInput,
} from "../../adapter.js";
import { CodexAdapter } from "../../agents/codex/adapter.js";
import { ClaudeAdapter } from "../../agents/claude/adapter.js";
import { PluginRegistry } from "../registry.js";
import { PLUGIN_API_VERSION, type AgentPlugin } from "../types.js";

function builtin(
  id: string,
  adapter: AgentAdapter,
  prepareWorkingDirectory?: (path: string) => void,
): AgentPlugin {
  const prepareInput = (input: AgentExecutionInput): AgentExecutionInput => {
    const context = input.context as { type?: string } | null;
    const keepSequence = id === "mock" && context?.type === "demo.loop";
    const { executionSequence, ...rest } = input;
    return keepSequence ? { ...rest, executionSequence } : rest;
  };
  return {
    manifest: {
      id,
      kind: "agent",
      apiVersion: PLUGIN_API_VERSION,
      version: "0.2.0",
    },
    ...(prepareWorkingDirectory ? { prepareWorkingDirectory } : {}),
    prepareInput,
    execute(input: AgentExecutionInput, signal?: AbortSignal) {
      return adapter.execute(prepareInput(input), signal);
    },
  };
}

export function createWorkerPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  const prepare = (path: string) => {
    mkdirSync(path, { recursive: true });
  };
  registry.register(builtin("mock", new MockAgentAdapter(), () => {}));
  registry.register(builtin("codex", new CodexAdapter(), prepare));
  registry.register(builtin("claude", new ClaudeAdapter(), prepare));
  return registry;
}
