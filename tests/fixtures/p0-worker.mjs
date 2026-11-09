// Runs the real compiled Worker with a local fake Agent and a test-controlled heartbeat.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const [base, workerId, markerPath] = process.argv.slice(2);
const originalInterval = globalThis.setInterval;
let heartbeat;
globalThis.setInterval = (fn, ms, ...args) => {
  if (ms === 10000) {
    heartbeat = () => fn(...args);
    const timer = originalInterval(() => {}, 60000);
    timer.unref();
    return timer;
  }
  return originalInterval(fn, ms, ...args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (String(args[0]).includes("/heartbeat"))
    process.send?.({ type: "heartbeat", status: response.status });
  return response;
};
process.on("message", (message) => {
  if (message === "heartbeat") heartbeat?.();
});

const fixture = fileURLToPath(new URL("./p0-fake-agent.mjs", import.meta.url));
const adapter = {
  async execute(input, signal) {
    const agent = fork(
      fixture,
      [
        markerPath,
        input.workItemId,
        input.executionId,
        input.externalSessionId ?? "",
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        detached: true,
      },
    );
    agent.on("message", (message) => process.send?.(message));
    const cancel = () => {
      if (agent.connected) agent.send("stop");
    };
    const actualSignal = signal ?? input.signal;
    actualSignal?.addEventListener("abort", cancel, { once: true });
    return await new Promise((resolve, reject) => {
      agent.once("error", reject);
      agent.once("exit", () => {
        actualSignal?.removeEventListener("abort", cancel);
        resolve({ type: "failed", error: "fake agent stopped" });
      });
    });
  },
};
try {
  const { workOnce } = await import("../../dist/worker.js");
  const worked = await workOnce(base, workerId, adapter);
  process.send?.({ type: "worker-done", worked }, () => process.disconnect?.());
} catch (error) {
  process.send?.({ type: "worker-error", message: String(error) }, () =>
    process.disconnect?.(),
  );
}
