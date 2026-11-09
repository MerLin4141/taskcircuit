// Runs the current Worker with a fake Agent and can crash after a Later commit.
import { workOnce } from "../../dist/worker.js";
const [base, mode] = process.argv.slice(2);
const originalFetch = globalThis.fetch;
if (mode === "commit-and-crash") {
  globalThis.fetch = async (...args) => {
    if (String(args[0]).endsWith("/result")) {
      const response = await originalFetch(...args);
      process.send?.({ type: "committed", status: response.status });
      return await new Promise(() => {});
    }
    return originalFetch(...args);
  };
}
const adapter = {
  async execute(input) {
    process.send?.({ type: "agent-input", session: input.externalSessionId });
    if (mode === "commit-and-crash")
      return {
        type: "later",
        sessionId: "worker-restart-session",
        message: "later",
        afterSeconds: 2,
      };
    return {
      type: "completed",
      sessionId: input.externalSessionId,
      output: "after restart",
    };
  },
};
try {
  const worked = await workOnce(base, mode, adapter);
  process.send?.({ type: "done", worked }, () => process.disconnect?.());
} catch (error) {
  process.send?.({ type: "error", message: String(error) }, () =>
    process.disconnect?.(),
  );
}
