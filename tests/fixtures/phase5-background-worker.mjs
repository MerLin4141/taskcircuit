import { workOnce } from "../../dist/worker.js";
const [base] = process.argv.slice(2);
let calls = 0;
const sessions = [];
const adapter = {
  async execute(input) {
    calls++;
    sessions.push(input.externalSessionId ?? "first");
    return calls < 3
      ? { type: "continue", sessionId: "fake", message: "next" }
      : { type: "completed", sessionId: "fake", output: "done" };
  },
};
try {
  while (calls < 3) {
    if (!(await workOnce(base, "fake-background-worker", adapter)))
      await new Promise((r) => setImmediate(r));
  }
  process.send?.({ calls, sessions });
} catch (e) {
  process.send?.({ error: String(e) });
  process.exitCode = 1;
}
