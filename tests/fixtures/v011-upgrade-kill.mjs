// Verifies crash recovery while opening a genuine v0.1.1 database; no schema downgrade is fabricated.
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
const [databasePath, markerPath, now] = process.argv.slice(2);
const original = DatabaseSync.prototype.exec;
let intercepted = false;
DatabaseSync.prototype.exec = function (sql) {
  const result = original.call(this, sql);
  if (!intercepted && sql === "BEGIN IMMEDIATE") {
    intercepted = true;
    writeFileSync(markerPath, "migration transaction entered");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  }
  return result;
};
const { createHub } = await import("../../dist/hub.js");
const { defaultConfig } = await import("../../dist/config.js");
createHub(databasePath, defaultConfig, () => Number(now), 0, {
  dispatcherPollMs: 0,
});
