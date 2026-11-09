import { createHash } from "node:crypto";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
export function pipePath(home) {
    const hash = createHash("sha256")
        .update(resolve(home).toLowerCase())
        .digest("hex")
        .slice(0, 20);
    return process.platform === "win32"
        ? `\\\\.\\pipe\\taskcircuit-${hash}`
        : join(tmpdir(), `taskcircuit-${hash}.sock`);
}
async function readMetadata(home) {
    try {
        const value = JSON.parse(await readFile(join(home, "runtime", "runtime.json"), "utf8"));
        if (!value || typeof value !== "object")
            return null;
        const m = value;
        return typeof m.runtimeId === "string" &&
            typeof m.token === "string" &&
            typeof m.pid === "number" &&
            typeof m.startedAt === "string"
            ? m
            : null;
    }
    catch {
        return null;
    }
}
async function request(home, meta, operation) {
    return new Promise((resolvePromise, reject) => {
        const socket = connect(pipePath(home));
        let text = "";
        socket.setTimeout(1500);
        socket.on("connect", () => socket.write(JSON.stringify({
            operation,
            token: meta.token,
            runtimeId: meta.runtimeId,
        }) + "\n"));
        socket.on("data", (chunk) => {
            text += String(chunk);
            if (text.includes("\n")) {
                try {
                    const response = JSON.parse(text.slice(0, text.indexOf("\n")));
                    socket.end();
                    if (response.runtimeId !== meta.runtimeId)
                        reject(new Error("运行实例身份不匹配"));
                    else
                        resolvePromise(response);
                }
                catch {
                    reject(new Error("运行实例响应无效"));
                }
            }
        });
        socket.on("timeout", () => socket.destroy(new Error("运行实例无响应")));
        socket.on("error", reject);
        socket.on("end", () => {
            if (!text)
                reject(new Error("运行实例无响应"));
        });
    });
}
export async function readRuntimeStatus(home) {
    const meta = await readMetadata(home);
    if (!meta)
        return { runtime: "stopped" };
    try {
        const status = await request(home, meta, "status");
        return {
            ...status,
            runtime: "running",
            startedAt: meta.startedAt,
            launcherPid: meta.pid,
        };
    }
    catch {
        return { runtime: "stale" };
    }
}
export async function stopRuntime(home) {
    const meta = await readMetadata(home);
    if (!meta)
        throw new Error("Runtime 未运行");
    await request(home, meta, "stop");
}
export async function waitStopped(home, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await readRuntimeStatus(home)).runtime !== "running")
            return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Runtime 停止超时");
}
export async function portOccupied(port = 4317) {
    return await new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(true);
        });
    });
}
