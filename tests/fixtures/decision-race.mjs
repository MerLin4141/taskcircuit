import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { evaluateDecision } from "../../dist/decision-core.js";
const [path, configPath, eventId, rootId, requestId] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
process.send?.("ready");
process.on("message", () => {
  try {
    process.send?.({
      result: evaluateDecision(
        db,
        { eventId, rootId, requestId, generation: 1 },
        { config: JSON.parse(readFileSync(configPath, "utf8")), now: () => 0 },
      ),
    });
  } catch (e) {
    process.send?.({ error: String(e) });
  } finally {
    db.close();
    process.disconnect();
  }
});
