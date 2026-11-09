import { DatabaseSync } from "node:sqlite";
import { migrateDecisionCore } from "../../dist/decision-core.js";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
migrateDecisionCore(db, (stage) => {
  if (stage === process.argv[3]) {
    process.send?.(stage);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
});
