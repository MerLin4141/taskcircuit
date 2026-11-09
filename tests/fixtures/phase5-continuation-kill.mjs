import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { materializeContinuation } from "../../dist/execution-admission.js";
const [path, configFile, parent, time] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
materializeContinuation(
  db,
  parent,
  JSON.parse(readFileSync(configFile, "utf8")),
  time,
  (stage) => {
    if (stage === "successor-inserted") {
      process.send?.(stage);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
  },
);
db.exec("COMMIT");
