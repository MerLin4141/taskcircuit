import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { materializeDecision } from "../../dist/decision-materialization.js";
const [path, configFile, decision] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
process.send?.("ready");
process.on("message", () => {
  try {
    process.send?.({
      result: materializeDecision(
        db,
        decision,
        JSON.parse(readFileSync(configFile, "utf8")),
        () => 0,
      ),
    });
  } catch (e) {
    process.send?.({ error: String(e) });
  } finally {
    db.close();
    process.disconnect();
  }
});
