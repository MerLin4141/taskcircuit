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
const second = `
ALTER TABLE executions ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE executions ADD COLUMN parent_execution_id TEXT REFERENCES executions(id);
ALTER TABLE executions ADD COLUMN retry_attempt INTEGER NOT NULL DEFAULT 0;
CREATE TABLE schedules(id TEXT PRIMARY KEY,config_key TEXT UNIQUE,kind TEXT NOT NULL,status TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT,reason TEXT NOT NULL,parent_execution_id TEXT REFERENCES executions(id),source TEXT,event_type TEXT,payload TEXT,expression TEXT,timezone TEXT,run_at TEXT,next_fire_at TEXT,last_fire_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX schedules_due ON schedules(status,next_fire_at);
CREATE TABLE schedule_firings(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES schedules(id),scheduled_for TEXT NOT NULL,event_id TEXT REFERENCES events(id),execution_id TEXT REFERENCES executions(id),created_at TEXT NOT NULL,UNIQUE(schedule_id,scheduled_for));
`;
const third = `
CREATE TABLE runtime_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,work_item_id TEXT,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE stream_retention(id INTEGER PRIMARY KEY CHECK(id=1),pruned_through INTEGER NOT NULL);
INSERT INTO stream_retention VALUES(1,0);
CREATE TABLE notifications(id TEXT PRIMARY KEY,kind TEXT NOT NULL,severity TEXT NOT NULL,work_item_id TEXT NOT NULL REFERENCES work_items(id),interaction_id TEXT REFERENCES interactions(id),title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT,dedupe_key TEXT UNIQUE NOT NULL);
CREATE TABLE notification_deliveries(id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),channel_id TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,not_before TEXT NOT NULL,claimed_by TEXT,lease_token TEXT,lease_expires_at TEXT,last_error TEXT,created_at TEXT NOT NULL,sent_at TEXT,UNIQUE(notification_id,channel_id));
CREATE INDEX notification_queue ON notification_deliveries(status,not_before,lease_expires_at);
CREATE TRIGGER changes_work_insert AFTER INSERT ON work_items BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('work_item.created','work_item',NEW.id,NEW.id,json_object('status',NEW.status),NEW.created_at); END;
CREATE TRIGGER changes_work_status AFTER UPDATE OF status ON work_items WHEN OLD.status<>NEW.status BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('work_item.status_changed','work_item',NEW.id,NEW.id,json_object('status',NEW.status),NEW.updated_at); END;
CREATE TRIGGER changes_execution_insert AFTER INSERT ON executions BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('execution.created','execution',NEW.id,NEW.work_item_id,json_object('status',NEW.status,'sequence',NEW.sequence),NEW.created_at); END;
CREATE TRIGGER changes_execution_started AFTER UPDATE OF status ON executions WHEN NEW.status='running' AND OLD.status<>'running' BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('execution.started','execution',NEW.id,NEW.work_item_id,json_object('status',NEW.status),NEW.started_at); END;
CREATE TRIGGER changes_execution_claimed AFTER UPDATE OF claimed_by ON executions WHEN NEW.status='running' AND (OLD.claimed_by IS NOT NEW.claimed_by OR OLD.lease_token IS NOT NEW.lease_token) BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('execution.claimed','execution',NEW.id,NEW.work_item_id,json_object('status',NEW.status),COALESCE(NEW.started_at,NEW.created_at)); END;
CREATE TRIGGER changes_execution_terminal AFTER UPDATE OF status ON executions WHEN OLD.status<>NEW.status AND NEW.status IN ('completed','failed','cancelled','waiting_input') BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES(CASE NEW.status WHEN 'completed' THEN 'execution.completed' WHEN 'failed' THEN 'execution.failed' WHEN 'cancelled' THEN 'execution.cancelled' ELSE 'execution.waiting_input' END,'execution',NEW.id,NEW.work_item_id,json_object('status',NEW.status),COALESCE(NEW.finished_at,NEW.created_at)); END;
CREATE TRIGGER changes_interaction_insert AFTER INSERT ON interactions BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('interaction.opened','interaction',NEW.id,NEW.work_item_id,json_object('key',NEW.key),NEW.created_at); END;
CREATE TRIGGER changes_interaction_status AFTER UPDATE OF status ON interactions WHEN OLD.status<>NEW.status BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES(CASE NEW.status WHEN 'resolved' THEN 'interaction.resolved' ELSE 'interaction.cancelled' END,'interaction',NEW.id,NEW.work_item_id,json_object('status',NEW.status),COALESCE(NEW.resolved_at,NEW.created_at)); END;
CREATE TRIGGER changes_session_insert AFTER INSERT ON agent_sessions BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('agent_session.created','agent_session',NEW.id,NEW.work_item_id,json_object('adapter',NEW.adapter),NEW.created_at); END;
CREATE TRIGGER changes_schedule_insert AFTER INSERT ON schedules BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES('schedule.created','schedule',NEW.id,CASE WHEN NEW.owner_kind='work_item' THEN NEW.owner_id ELSE NULL END,json_object('kind',NEW.kind,'reason',NEW.reason),NEW.created_at); END;
CREATE TRIGGER changes_schedule_status AFTER UPDATE OF status ON schedules WHEN OLD.status<>NEW.status AND NEW.status IN ('paused','active','cancelled') BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) VALUES(CASE NEW.status WHEN 'paused' THEN 'schedule.paused' WHEN 'active' THEN 'schedule.resumed' ELSE 'schedule.cancelled' END,'schedule',NEW.id,CASE WHEN NEW.owner_kind='work_item' THEN NEW.owner_id ELSE NULL END,json_object('status',NEW.status),NEW.updated_at); END;
CREATE TRIGGER changes_schedule_fired AFTER INSERT ON schedule_firings BEGIN INSERT INTO runtime_changes(type,entity_type,entity_id,work_item_id,payload,created_at) SELECT 'schedule.fired','schedule',s.id,CASE WHEN s.owner_kind='work_item' THEN s.owner_id ELSE NULL END,json_object('scheduledFor',NEW.scheduled_for),NEW.created_at FROM schedules s WHERE s.id=NEW.schedule_id; END;
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
    if (
      !db.prepare("SELECT version FROM schema_migrations WHERE version=2").get()
    ) {
      db.exec(second);
      db.prepare("INSERT INTO schema_migrations VALUES(2,?)").run(
        new Date().toISOString(),
      );
    }
    if (
      !db.prepare("SELECT version FROM schema_migrations WHERE version=3").get()
    ) {
      db.exec(third);
      db.prepare("INSERT INTO schema_migrations VALUES(3,?)").run(
        new Date().toISOString(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
