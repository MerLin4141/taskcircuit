// Generates fixtures with the archived v0.1.1 implementation, never the current Hub.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const commit = "4fb7cf13fd7c243c8d2bd82ece34f75ae37a55df";
const expected = {
  "hub.ts": "71eff5fed1c5a1a07daabcab27d8e1f68a4dc62bafa5f45e2d41fbe88eb2bedb",
  "migration.ts":
    "bd05b0cbd82dd04b2fac5ca6fe5c0269062e89eeb4eeec740924fdc577ed4bf3",
  "worker.ts":
    "e42e9f5ba481b5afa1f893372d207a4754af2ea9881c1a91f931827a0ee8362f",
  "config.ts":
    "5e5cb826f25e93019f14d52b15e928a7316b8d1ef78f4f47db21dc8aeb7e98b4",
};
const [legacyArg, outputArg] = process.argv.slice(2);
if (!legacyArg || !outputArg)
  throw new Error(
    "Usage: node generate-v011-fixture.mjs <archived-v011-dir> <output-json>",
  );
const legacy = resolve(legacyArg);
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
for (const [name, hash] of Object.entries(expected))
  if (sha(readFileSync(join(legacy, "src", name))) !== hash)
    throw new Error(`Wrong v0.1.1 source: ${name}`);
const { createHub } = await import(
  pathToFileURL(join(legacy, "dist", "hub.js")).href
);
const { defaultConfig } = await import(
  pathToFileURL(join(legacy, "dist", "config.js")).href
);
const temp = resolve(mkdtempSync(join(tmpdir(), "taskcircuit-v011-fixture-")));
const rel = relative(resolve(tmpdir()), temp);
if (
  !rel ||
  rel.startsWith("..") ||
  isAbsolute(rel) ||
  !rel.startsWith("taskcircuit-v011-fixture-")
)
  throw new Error("Unexpected temporary path");
const clock = Date.parse("2026-01-01T00:00:00Z");
const post = (hub, url, payload) =>
  hub.inject({ method: "POST", url, payload });
async function checked(hub, url, payload) {
  const r = await post(hub, url, payload);
  if (r.statusCode !== 200)
    throw new Error(
      `v0.1.1 fixture generation failed at ${url}: ${r.statusCode}`,
    );
  return r.json();
}
function bytes(path) {
  const db = new DatabaseSync(path);
  const versions = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => Number(row.version));
  if (JSON.stringify(versions) !== "[1,2,3,4]")
    throw new Error("Unexpected legacy schema");
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (Object.values(integrity)[0] !== "ok")
    throw new Error("Legacy fixture corrupt");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const raw = readFileSync(path);
  return {
    sha256: sha(raw),
    gzipBase64: gzipSync(raw, { level: 9 }).toString("base64"),
  };
}
try {
  const emptyPath = join(temp, "empty");
  let hub = createHub(emptyPath, defaultConfig, () => clock, 0, {
    dispatcherPollMs: 0,
  });
  await hub.close();
  const historyPath = join(temp, "history");
  hub = createHub(historyPath, defaultConfig, () => clock, 0, {
    dispatcherPollMs: 0,
  });
  const items = {};
  async function create(kind, type, result) {
    const made = await checked(hub, "/api/events", {
      source: "local",
      type,
      payload: { sample: kind },
    });
    const c = await checked(hub, "/api/executions/claim", {
      workerId: "fixture-worker",
    });
    if (c.execution.id !== made.execution.id)
      throw new Error("Unexpected execution order");
    items[kind] = { workId: made.workItem.id, executionId: c.execution.id };
    if (result)
      await checked(hub, `/api/executions/${c.execution.id}/result`, {
        workerId: "fixture-worker",
        leaseToken: c.leaseToken,
        result,
      });
  }
  await create("completed", "demo.color", {
    type: "completed",
    sessionId: "legacy-complete-session",
    output: "legacy done",
  });
  await create("ask", "demo.color", {
    type: "needs_input",
    sessionId: "legacy-ask-session",
    request: {
      title: "Legacy question",
      text: "Choose",
      key: "legacy-q",
      options: ["yes", "no"],
    },
  });
  await create("later", "demo.later", {
    type: "later",
    sessionId: "legacy-later-session",
    message: "later",
    afterSeconds: 2,
  });
  await create("retry", "demo.retry", {
    type: "failed",
    sessionId: "legacy-retry-session",
    error: {
      code: "agent_execution",
      message: "legacy retry",
      retryable: true,
    },
  });
  await create("failed", "demo.color", {
    type: "failed",
    error: {
      code: "agent_execution",
      message: "legacy terminal",
      retryable: false,
    },
  });
  await create("running", "demo.lease", null);
  await hub.close();
  const document = {
    generatedByCommit: commit,
    generatorNode: process.version,
    sourceSha256: expected,
    clock,
    empty: bytes(emptyPath),
    history: bytes(historyPath),
    items,
  };
  writeFileSync(
    resolve(outputArg),
    JSON.stringify(document, null, 2) + "\n",
    "utf8",
  );
  console.log(
    "Generated two genuine v0.1.1 databases: empty and mixed-history",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
