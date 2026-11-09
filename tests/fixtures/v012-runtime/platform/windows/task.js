import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { stopRuntime } from "./runtime.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export function taskName(home, defaultHome = join(homedir(), ".taskcircuit")) {
    const canonical = (v) => resolve(v).toLowerCase();
    return canonical(home) === canonical(defaultHome)
        ? "TaskCircuit"
        : `TaskCircuit-${createHash("sha256").update(canonical(home)).digest("hex").slice(0, 8)}`;
}
export async function task(action, home, name = taskName(home), workspaceRoot) {
    if (process.platform !== "win32")
        throw new Error("当前平台不支持 Windows Runtime 集成");
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = join(root, "scripts", "windows", "task.ps1");
    const launcher = join(root, "dist", "platform", "windows", "launcher.js");
    const job = join(root, "scripts", "windows", "job.ps1");
    const args = [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script,
        "-Action",
        action,
        "-Name",
        name,
    ];
    if (action === "install") {
        if (!existsSync(launcher) || !existsSync(job))
            throw new Error("Runtime 启动文件不存在，请先构建项目");
        mkdirSync(resolve(home), { recursive: true });
        args.push("-Node", process.execPath, "-Launcher", launcher, "-RuntimeHome", resolve(home), "-AppDir", root, "-JobScript", job);
    }
    if (workspaceRoot)
        args.push("-WorkspaceRoot", resolve(workspaceRoot));
    const { stdout } = await run(powershell, args, {
        windowsHide: true,
        encoding: "utf8",
        timeout: 30000,
    });
    return JSON.parse(stdout);
}
export async function runContained(home) {
    if (process.platform !== "win32")
        throw new Error("当前平台不支持 Windows Runtime 集成");
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const job = join(root, "scripts", "windows", "job.ps1");
    const launcher = join(root, "dist", "platform", "windows", "launcher.js");
    const { spawn } = await import("node:child_process");
    const { child, completion } = (() => {
        const child = spawn(powershell, [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            job,
            "-Node",
            process.execPath,
            "-Launcher",
            launcher,
            "-RuntimeHome",
            resolve(home),
            "-AppDir",
            root,
        ], { stdio: "ignore", windowsHide: true, shell: false, detached: true });
        const completion = new Promise((resolvePromise, reject) => {
            child.on("error", reject);
            child.on("exit", (code) => resolvePromise(code ?? 1));
        });
        return { child, completion };
    })();
    let stopping = false;
    const stop = () => {
        if (stopping)
            return;
        stopping = true;
        void (async () => {
            for (let i = 0; i < 150 && child.exitCode === null; i++) {
                try {
                    await stopRuntime(home);
                    return;
                }
                catch {
                    await new Promise((r) => setTimeout(r, 100));
                }
            }
        })();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
        return await completion;
    }
    finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
    }
}
