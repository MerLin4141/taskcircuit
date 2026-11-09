// Supplies synthetic Generation 2 stores to tests that exercise the Hub directly.
import { DatabaseSync } from "node:sqlite";
import { createHub as actual } from "../../src/hub.js";
import { migrate } from "../../src/migration.js";
export function createHub(
  ...args: Parameters<typeof actual>
): ReturnType<typeof actual> {
  if (args[0] !== ":memory:") {
    const db = new DatabaseSync(args[0]);
    try {
      db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
      migrate(db);
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name='taskcircuit_generation'",
          )
          .get()
      ) {
        db.exec(
          "CREATE TABLE taskcircuit_generation(migration_id TEXT NOT NULL,generation INTEGER NOT NULL); INSERT INTO taskcircuit_generation VALUES('fixture',2); INSERT INTO schema_migrations VALUES(5,'2026-01-01T00:00:00Z')",
        );
      }
    } finally {
      db.close();
    }
  }
  return actual(...args);
}
