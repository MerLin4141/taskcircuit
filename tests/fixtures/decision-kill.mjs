import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { evaluateDecision } from "../../dist/decision-core.js";
const [path, configPath, eventId, rootId] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
evaluateDecision(
  db,
  { requestId: "killed", eventId, rootId, generation: 1 },
  {
    config: JSON.parse(readFileSync(configPath, "utf8")),
    now: () => 0,
    onStage(stage) {
      if (stage === "decision-inserted") {
        process.send?.(stage);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    },
  },
);
