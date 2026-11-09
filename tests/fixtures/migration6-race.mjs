import { DatabaseSync } from "node:sqlite";
import { migrateDomain } from "../../dist/automation-domain.js";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
process.send?.("ready");
process.on("message", () => {
  try {
    migrateDomain(db);
    process.send?.("done");
  } catch (e) {
    process.send?.({ error: String(e) });
  } finally {
    db.close();
    process.disconnect();
  }
});
