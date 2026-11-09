import { DatabaseSync } from "node:sqlite";
import { ingestEvent } from "../../dist/event-core.js";
const [path, checkpoint] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
ingestEvent(
  db,
  { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
  {
    sourceEventId: "atomic",
    type: "demo.color",
    automationId: "automation-a",
    correlationKey: "atomic",
    payload: { x: 1 },
  },
  {
    knownTypes: new Set(["demo.color"]),
    now: () => 0,
    onStage(stage) {
      if (stage === checkpoint) {
        process.send?.(stage);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    },
  },
);
