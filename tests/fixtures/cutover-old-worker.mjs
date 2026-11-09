import { workOnce } from "./v012-runtime/worker.js";
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input).includes("/api/executions/claim"))
    process.send?.({ type: "claim-request" });
  return originalFetch(input, init);
};
process.send?.({ type: "worker-start" });
try {
  await workOnce(process.argv[2], "old-cutover-test", {
    execute: async () => {
      process.send?.({ type: "agent-called" });
      return { type: "completed", sessionId: "fake", output: "done" };
    },
  });
  process.send?.({ type: "worker-return" });
} catch {
  process.send?.({ type: "worker-error" });
}
process.disconnect?.();
