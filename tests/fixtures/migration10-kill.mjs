import { DatabaseSync } from "node:sqlite";
import { migrateLoopLimits } from "../../dist/loop-limits.js";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA foreign_keys=ON");
migrateLoopLimits(db, (stage) => {
  if (stage === process.argv[3]) {
    process.send?.(stage);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
});
