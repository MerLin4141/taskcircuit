// Guards concurrent continuation materialization across independent SQLite processes.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { materializeContinuation } from "../../dist/execution-admission.js";
const [path, configPath, parent, time] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
process.send?.("ready");
process.on("message", () => {
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = materializeContinuation(
      db,
      parent,
      JSON.parse(readFileSync(configPath, "utf8")),
      time,
    );
    db.exec("COMMIT");
    process.send?.({ result });
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    process.send?.({ error: String(e) });
  } finally {
    db.close();
    process.disconnect();
  }
});
