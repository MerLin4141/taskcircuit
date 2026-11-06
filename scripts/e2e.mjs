import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../dist/hub.js";
import { defaultConfig } from "../dist/config.js";
import { ProcessRunner } from "../dist/agents/process.js";
const kind = process.argv[2];
if (!["codex", "claude"].includes(kind)) throw new Error("adapter required");
const root = mkdtempSync(join(tmpdir(), "taskcircuit-e2e-"));
const home = join(root, "state");
const workspaceRoot = join(root, "workspace");
mkdirSync(home);
const db = join(home, "taskcircuit.db");
let hub;
let phase = "start";
const request = async (base, path, body) => {
  const response = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};
const start = async () => {
  hub = createHub(db, defaultConfig);
  return await hub.listen({ port: 0, host: "127.0.0.1" });
};
const worker = async (base) => {
  const r = await new ProcessRunner().run({
    executable: process.execPath,
    args: [join(process.cwd(), "scripts", "e2e-worker.mjs"), base],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TASKCIRCUIT_HOME: home,
      TASKCIRCUIT_WORKSPACE_ROOT: workspaceRoot,
    },
    timeoutMs: 320000,
  });
  if (r.exitCode !== 0) throw new Error("worker failed");
};
try {
  let base = await start();
  const created = await request(base, "/api/events", {
    source: "local",
    type: `demo.${kind}.color`,
    payload: {},
  });
  const id = created.workItem.id;
  phase = "first execution";
  await worker(base);
  let detail = await request(base, `/api/work-items/${id}`);
  if (detail.workItem.status !== "waiting_input")
    throw new Error(
      `first execution: ${JSON.stringify(detail.executions[0].error)}`,
    );
  const session = detail.agentSession;
  const interaction = detail.interactions[0];
  if (
    !Array.isArray(interaction.request.options) ||
    !interaction.request.options.includes("蓝色") ||
    !interaction.request.options.includes("绿色")
  )
    throw new Error("问题没有提供蓝色和绿色选项");
  const first = detail.executions[0].id;
  await hub.close();
  hub = undefined;
  base = await start();
  detail = await request(base, `/api/work-items/${id}`);
  if (
    detail.interactions[0].status !== "open" ||
    detail.agentSession.externalSessionId !== session.externalSessionId
  )
    throw new Error("restart persistence failed");
  phase = "resume";
  await request(base, `/api/interactions/${interaction.id}/answer`, {
    answer: "蓝色",
  });
  await worker(base);
  detail = await request(base, `/api/work-items/${id}`);
  const second = detail.executions[1];
  if (
    detail.workItem.status !== "completed" ||
    second.output !== "你选了蓝色，TaskCircuit 试跑通过" ||
    second.id === first ||
    second.agentSessionId !== session.id ||
    detail.agentSession.externalSessionId !== session.externalSessionId
  )
    throw new Error(
      `resume: ${JSON.stringify(second?.error)}; status ${detail.workItem.status}; output ${JSON.stringify(second?.output)}`,
    );
  console.log(
    JSON.stringify(
      {
        adapter: kind,
        workItemId: id,
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
