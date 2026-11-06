import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../dist/hub.js";
import { defaultConfig } from "../dist/config.js";
import { ProcessRunner } from "../dist/agents/process.js";
const kind = process.argv[2];
if (!["codex", "claude"].includes(kind)) throw new Error("adapter required");
const root = mkdtempSync(join(tmpdir(), "tc-later-"));
const home = join(root, "state");
mkdirSync(home);
const db = join(home, "taskcircuit.db");
const workspace = join(root, "workspace");
let hub;
let phase = "create";
const request = async (base, path, data) => {
  const res = await fetch(
    base + path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
const start = async () => {
  hub = createHub(db, defaultConfig);
  return await hub.listen({ host: "127.0.0.1", port: 0 });
};
const worker = async (base) => {
  const r = await new ProcessRunner().run({
    executable: process.execPath,
    args: [join(process.cwd(), "scripts", "e2e-worker.mjs"), base],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TASKCIRCUIT_HOME: home,
      TASKCIRCUIT_WORKSPACE_ROOT: workspace,
    },
    timeoutMs: 320000,
  });
  if (r.exitCode !== 0) throw new Error("worker failed");
};
try {
  let base = await start();
  const work = (
    await request(base, "/api/events", {
      source: "local",
      type: `demo.${kind}.later`,
      payload: {},
    })
  ).workItem;
  await worker(base);
  let d = await request(base, `/api/work-items/${work.id}`);
  if (d.workItem.status !== "waiting_schedule")
    throw new Error(
      `later not scheduled: ${JSON.stringify(d.executions[0].error)}`,
    );
  const session = d.agentSession;
  const first = d.executions[0].id;
  await hub.close();
  hub = undefined;
  phase = "restart";
  await new Promise((r) => setTimeout(r, 2200));
  base = await start();
  hub.tickScheduler();
  await worker(base);
  d = await request(base, `/api/work-items/${work.id}`);
  const second = d.executions[1];
  const expected = `TaskCircuit ${kind === "codex" ? "Codex" : "Claude"} Later 试跑通过`;
  if (
    d.workItem.status !== "completed" ||
    second.output !== expected ||
    second.agentSessionId !== session.id ||
    d.agentSession.externalSessionId !== session.externalSessionId ||
    first === second.id
  )
    throw new Error(
      `resume failed: ${JSON.stringify(second?.error)}; output ${JSON.stringify(second?.output)}`,
    );
  console.log(
    JSON.stringify(
      {
        adapter: kind,
        workItemId: work.id,
        execution1Id: first,
        execution2Id: second.id,
        agentSessionId: session.id,
        externalSessionSame: true,
        hubRestart: true,
        result: second.output,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      adapter: kind,
      phase,
      error: error instanceof Error ? error.message : "failed",
    }),
  );
  process.exitCode = 1;
} finally {
  if (hub) await hub.close();
  rmSync(root, { recursive: true, force: true });
}
