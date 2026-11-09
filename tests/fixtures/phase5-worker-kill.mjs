import { writeFileSync } from "node:fs";
import { workOnce } from "../../dist/worker.js";
const [base, marker] = process.argv.slice(2);
process.on("message", () => {});
const adapter = {
  async execute() {
    writeFileSync(marker, "started");
    process.send?.({ type: "agent-started" });
    return await new Promise(() => {});
  },
};
try {
  await workOnce(base, "kill-worker", adapter);
} catch (e) {
  process.send?.({ type: "error", message: String(e) });
}
