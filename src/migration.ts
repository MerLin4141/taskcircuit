import { DatabaseSync } from "node:sqlite";
const first = `
CREATE TABLE events(id TEXT PRIMARY KEY,source TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE agent_profiles(id TEXT PRIMARY KEY,name TEXT NOT NULL,adapter TEXT NOT NULL,model TEXT,reasoning TEXT,config TEXT NOT NULL);
CREATE TABLE work_items(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,route_id TEXT NOT NULL,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT,metadata TEXT NOT NULL);
CREATE TABLE agent_sessions(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),adapter TEXT NOT NULL,external_session_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,metadata TEXT NOT NULL);
CREATE TABLE executions(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL REFERENCES work_items(id),sequence INTEGER NOT NULL,status TEXT NOT NULL,agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),agent_session_id TEXT REFERENCES agent_sessions(id),claimed_by TEXT,lease_token TEXT,lease_expires_at TEXT,not_before TEXT NOT NULL,input TEXT NOT NULL,output TEXT,error TEXT,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,UNIQUE(work_item_id,sequence));
CREATE TABLE interactions(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL REFERENCES work_items(id),execution_id TEXT NOT NULL REFERENCES executions(id),type TEXT NOT NULL,status TEXT NOT NULL,key TEXT,request TEXT NOT NULL,response TEXT,created_at TEXT NOT NULL,resolved_at TEXT);
CREATE INDEX execution_queue ON executions(status,not_before,lease_expires_at);
CREATE INDEX work_execution ON executions(work_item_id,sequence);
CREATE INDEX work_interaction ON interactions(work_item_id,created_at);
`;
export function migrate(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    const applied = db
      .prepare("SELECT version FROM schema_migrations WHERE version=1")
      .get();
    if (!applied) {
      db.exec(first);
      db.prepare("INSERT INTO schema_migrations VALUES(1,?)").run(
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
