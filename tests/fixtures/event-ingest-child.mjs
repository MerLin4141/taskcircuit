import { DatabaseSync } from "node:sqlite";
import { ingestEvent } from "../../dist/event-core.js";
const [path, id, key] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
process.send?.("ready");
process.on("message", () => {
  try {
    const result = ingestEvent(
      db,
      { sourceInstance: "local-cli", trustContext: "trusted_local_cli" },
      {
        sourceEventId: id,
        type: "demo.color",
        automationId: "automation-a",
        correlationKey: key,
        payload: { x: 1 },
      },
      {
        knownTypes: new Set(["demo.color"]),
        now: () => Date.parse("2026-01-01T00:00:00Z"),
      },
    );
    process.send?.({ result });
  } catch (e) {
    process.send?.({ error: String(e) });
  } finally {
    db.close();
    process.disconnect();
  }
});
