import { spawn } from "node:child_process";
import { join } from "node:path";
import { AgentExecutionError, AgentTimeoutError, classifyStartFailure, } from "./errors.js";
export class ProcessRunner {
    run(spec) {
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
                    detached: process.platform !== "win32",
                    stdio: "pipe",
                });
            }
            catch (error) {
                reject(classifyStartFailure(error));
                return;
            }
            let spawned = false;
            child.once("spawn", () => {
                spawned = true;
            });
            let stdout = "", stderr = "", reason = "";
            let forceTimer;
            let stopDeadline;
            let cleanup;
            let terminating = false;
            const terminate = () => {
                if (terminating || !child.pid)
                    return;
                terminating = true;
                stopDeadline = setTimeout(() => reject(new AgentExecutionError("Agent process termination could not be confirmed", false, true)), 4000);
                if (process.platform === "win32") {
                    cleanup = new Promise((resolve) => {
                        const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
                        let finished = false;
                        const done = (failed) => {
                            if (finished)
                                return;
                            finished = true;
                            clearTimeout(forceTimer);
                            if (failed &&
                                child.exitCode === null &&
                                child.signalCode === null)
                                child.kill();
                            resolve();
                        };
                        try {
                            const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
                            killer.once("error", () => done(true));
                            killer.once("exit", (code) => done(code !== 0));
                            forceTimer = setTimeout(() => done(true), 2000);
                        }
                        catch {
                            done(true);
                        }
                    });
                }
                else {
                    try {
                        process.kill(-child.pid, "SIGTERM");
                    }
                    catch {
                        child.kill();
                    }
                    cleanup = new Promise((resolve) => {
                        forceTimer = setTimeout(() => {
                            try {
                                process.kill(-child.pid, "SIGKILL");
                            }
                            catch { }
                            resolve();
                        }, 200);
                    });
                }
            };
            const limit = 4 * 1024 * 1024;
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
                if (stdout.length > limit) {
                    reason = "Agent 输出过大";
                    terminate();
                }
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk;
                if (stderr.length > limit) {
                    reason = "Agent 错误输出过大";
                    terminate();
                }
            });
            const abort = () => {
                if (!reason)
                    reason = "Agent 执行已中止";
                terminate();
            };
            spec.signal?.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(() => {
                if (!reason)
                    reason = "Agent 执行超时";
                terminate();
            }, spec.timeoutMs);
            child.on("error", async (error) => {
                clearTimeout(timer);
                if (spawned) {
                    terminate();
                    if (cleanup)
                        await cleanup;
                    clearTimeout(stopDeadline);
                }
                spec.signal?.removeEventListener("abort", abort);
                reject(spawned
                    ? new AgentExecutionError("Agent process error", false, true)
                    : classifyStartFailure(error));
            });
            child.on("close", async (exitCode) => {
                clearTimeout(timer);
                if (cleanup)
                    await cleanup;
                clearTimeout(stopDeadline);
                clearTimeout(forceTimer);
                spec.signal?.removeEventListener("abort", abort);
                if (reason === "Agent 执行超时")
                    reject(new AgentTimeoutError());
                else if (reason)
                    reject(new AgentExecutionError(reason, false, spawned));
                else
                    resolve({ exitCode, stdout, stderr });
            });
            child.stdin.on("error", () => { });
            child.stdin.end(spec.stdin ?? "");
        });
    }
}
