import { existsSync } from "node:fs";
import { join } from "node:path";
import { delimiter } from "node:path";
import { AgentUnavailableError } from "./errors.js";
import { agentEnvironment } from "./environment.js";
export interface Executable {
  executable: string;
  prefix: string[];
}
export function supportsCli(kind: "codex" | "claude", help: string): boolean {
  if (
    /\b(?:unknown|unrecognized|unsupported|invalid)\s+(?:option|argument|flag)\b/i.test(
      help,
    )
  )
    return false;
  return kind === "codex"
    ? help.includes("--json") && help.includes("resume")
    : help.includes("--print") &&
        help.includes("--output-format") &&
        help.includes("--resume");
}
export function resolveCli(
  kind: "codex" | "claude",
  env: NodeJS.ProcessEnv = process.env,
): Executable {
  if (process.platform !== "win32") return { executable: kind, prefix: [] };
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (kind === "codex") {
      const js = join(
        dir,
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js",
      );
      if (existsSync(js)) return { executable: process.execPath, prefix: [js] };
    } else {
      const exe = join(
        dir,
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (existsSync(exe)) return { executable: exe, prefix: [] };
    }
    const exe = join(dir, `${kind}.exe`);
    if (existsSync(exe)) return { executable: exe, prefix: [] };
  }
  throw new AgentUnavailableError();
}

export async function detectCli(
  kind: "codex" | "claude",
  runner: import("./process.js").Runner,
  cwd: string,
  executable?: Executable,
): Promise<boolean> {
  const command = executable ?? resolveCli(kind);
  const args = kind === "codex" ? ["exec", "--help"] : ["--help"];
  const result = await runner.run({
    executable: command.executable,
    args: [...command.prefix, ...args],
    cwd,
    env: agentEnvironment(process.env, kind),
    timeoutMs: 10000,
  });
  return (
    result.exitCode === 0 &&
    supportsCli(kind, result.stdout) &&
    !/\b(?:unknown|unrecognized|unsupported|invalid)\s+(?:option|argument|flag)\b/i.test(
      result.stderr,
    )
  );
}
