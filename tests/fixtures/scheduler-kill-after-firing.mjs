import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { createHub } from "../../dist/hub.js";
import { defaultConfig } from "../../dist/config.js";
const [path, timestamp, marker] = process.argv.slice(2);
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  if (sql.startsWith("INSERT INTO schedule_firings(")) {
    const run = statement.run;
    statement.run = function (...args) {
      const result = run.apply(this, args);
      writeFileSync(marker, "inserted-before-schedule-update");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return result;
    };
  }
  return statement;
};
const hub = createHub(path, defaultConfig, () => Number(timestamp), 0);
hub.tickScheduler();
process.exitCode = 1;
