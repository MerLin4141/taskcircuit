import { spawn } from "node:child_process";
import {
  AgentExecutionError,
  AgentTimeoutError,
  AgentUnavailableError,
} from "./errors.js";
export interface ProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin?: string;
}
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}
export interface Runner {
  run(spec: ProcessSpec): Promise<ProcessResult>;
}
export class ProcessRunner implements Runner {
  run(spec: ProcessSpec): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      if (spec.signal?.aborted) {
        reject(new AgentExecutionError("Agent 执行已中止"));
        return;
      }
      let child;
      try {
        child = spawn(spec.executable, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          shell: false,
          windowsHide: true,
          stdio: "pipe",
        });
      } catch {
        reject(new AgentUnavailableError());
        return;
      }
      let stdout = "",
        stderr = "",
        reason = "";
      const limit = 4 * 1024 * 1024;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.length > limit) {
          reason = "Agent 输出过大";
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.length > limit) {
          reason = "Agent 错误输出过大";
          child.kill();
        }
      });
      const abort = () => {
        reason = "Agent 执行已中止";
        child.kill();
      };
      spec.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        reason = "Agent 执行超时";
        child.kill();
      }, spec.timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", abort);
        reject(new AgentUnavailableError());
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", abort);
        if (reason === "Agent 执行超时") reject(new AgentTimeoutError());
        else if (reason) reject(new AgentExecutionError(reason));
        else resolve({ exitCode, stdout, stderr });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(spec.stdin ?? "");
    });
  }
}
