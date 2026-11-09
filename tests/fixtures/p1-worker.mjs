// Holds a committed response so the test can kill this Worker before it receives the response.
import { workOnce } from "../../dist/worker.js";
const [base] = process.argv.slice(2);
const original = globalThis.fetch;
globalThis.fetch = async (...args) => {
  if (String(args[0]).endsWith("/result")) {
    const body = JSON.parse(String(args[1]?.body));
    const response = await original(...args);
    process.send?.({
      type: "committed",
      status: response.status,
      submissionId: body.submissionId,
      digest: body.resultDigest,
    });
    return await new Promise(() => {});
  }
  return original(...args);
};
const adapter = {
  async execute() {
    process.send?.({ type: "agent-called" });
    return { type: "completed", sessionId: "fake-session", output: "done" };
  },
};
await workOnce(base, "p1-worker", adapter);
