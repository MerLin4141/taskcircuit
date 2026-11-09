// Prevents unknown Agent execution from being repeated and stale results from changing durable state.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createHub } from "../src/hub.js";
import { defaultConfig } from "../src/config.js";
import { workOnce } from "../src/worker.js";
import {
  AgentExecutionError,
  AgentTimeoutError,
} from "../src/agents/errors.js";
import type { AgentAdapter } from "../src/adapter.js";
import { ProcessRunner } from "../src/agents/process.js";

type Message = {
  type: string;
  pid?: number;
  port?: number;
  token?: string;
  executionId?: string;
  session?: string;
  status?: number;
  message?: string;
};
type Agent = Required<Pick<Message, "pid" | "port" | "token">> & Message;
type Hub = ReturnType<typeof createHub>;

const roots: string[] = [];
const workers: ChildProcess[] = [];
const agents: Agent[] = [];
const hubs: Hub[] = [];
let clock = 0;

function makeHub() {
  const root = mkdtempSync(join(tmpdir(), "tc-p0-fault-"));
  roots.push(root);
  clock = Date.parse("2026-01-01T00:00:00Z");
  const hub = createHub(
    join(root, "db.sqlite"),
    defaultConfig,
    () => clock,
    0,
    {
      dispatcherPollMs: 0,
    },
  );
  hubs.push(hub);
  return { hub, root, marker: join(root, "effects.jsonl") };
}
const post = (hub: Hub, url: string, payload: unknown) =>
  hub.inject({ method: "POST", url, payload });
async function create(hub: Hub, type = "demo.retry") {
  const response = await post(hub, "/api/events", {
    source: "local",
    type,
    payload: {},
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
const detail = async (hub: Hub, id: string) =>
  (await hub.inject(`/api/work-items/${id}`)).json();
function entries(path: string): Message[] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
function control(agent: Agent, command: "status" | "stop") {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(agent.port, "127.0.0.1");
    let response = "";
    socket.setTimeout(1000, () =>
      socket.destroy(new Error("agent control timeout")),
    );
    socket.on("connect", () =>
      socket.write(
        agent.token + (command === "status" ? ":status" : "") + "\n",
      ),
    );
    socket.on("data", (chunk) => (response += String(chunk)));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}
function startWorker(base: string, id: string, marker: string, root: string) {
  const child = fork(
    join(process.cwd(), "tests", "fixtures", "p0-worker.mjs"),
    [base, id, marker],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      env: {
        ...process.env,
        TASKCIRCUIT_HOME: join(root, "state"),
        TASKCIRCUIT_WORKSPACE_ROOT: join(root, "work"),
      },
    },
  );
  workers.push(child);
  const queue: Message[] = [];
  let wake: (() => void) | undefined;
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => (stderr += String(data)));
  child.stdout?.on("error", (error) => {
    stderr += `stdout stream: ${error.message}`;
  });
  child.stderr?.on("error", (error) => {
    stderr += `stderr stream: ${error.message}`;
  });
  child.on("message", (value: Message) => {
    queue.push(value);
    if (value.type === "agent-started") agents.push(value as Agent);
    wake?.();
  });
  async function next(types: string[], timeout = 5000): Promise<Message> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const index = queue.findIndex(
        (message) =>
          types.includes(message.type) || message.type === "worker-error",
      );
      if (index >= 0) {
        const [message] = queue.splice(index, 1);
        if (message.type === "worker-error")
          throw new Error(message.message ?? "worker error");
        return message;
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `worker exited before ${types.join("/")} (exit=${child.exitCode}, signal=${child.signalCode}): ${stderr}`,
        );
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(`timeout waiting for ${types.join("/")}: ${stderr}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, remaining);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve();
        };
      });
    }
  }
  return { child, next };
}
async function killWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("test worker did not exit")),
      3000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    if (
      !child.kill() &&
      (child.exitCode !== null || child.signalCode !== null)
    ) {
      clearTimeout(timeout);
      resolve();
    }
  });
}
async function stopped(agent: Agent) {
  const deadline = Date.now() + 1000;
  do {
    try {
      if ((await control(agent, "status")) !== "running") return true;
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

beforeAll(() => {
  // Child workers must run code built from the checked-out source, not stale dist.
  const source = readFileSync(join(process.cwd(), "src", "worker.ts"), "utf8");
  const built = readFileSync(join(process.cwd(), "dist", "worker.js"), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: "worker.mts",
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  if (compiled.replace(/\r\n/g, "\n") !== built.replace(/\r\n/g, "\n"))
    throw new Error(
      "dist/worker.js is stale; build before running process tests",
    );
});

afterEach(async () => {
  for (const root of roots) {
    for (const item of entries(join(root, "effects.jsonl"))) {
      if (
        item.pid &&
        item.port &&
        item.token &&
        !agents.some((a) => a.token === item.token)
      )
        agents.push(item as Agent);
    }
  }
  for (const agent of agents.splice(0)) {
    try {
      await control(agent, "stop");
    } catch {
      /* already stopped */
    }
  }
  for (const child of workers.splice(0)) await killWorker(child);
  for (const hub of hubs.splice(0)) await hub.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("P0 uncertain Agent execution", () => {
  it("does not rerun after the Worker dies after the Agent side effect", async () => {
    const { hub, root, marker } = makeHub();
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    const created = await create(hub);
    const a = startWorker(base, "worker-a", marker, root);
    const first = await a.next(["agent-started"]);
    expect(first.executionId).toBe(created.execution.id);
    expect(first.session).toBe("");
    expect(entries(marker)).toHaveLength(1);
    await killWorker(a.child);
    expect(
      await control(first as Agent, "status").catch((error) => {
        throw new Error("Agent control after Worker termination failed", {
          cause: error,
        });
      }),
    ).toBe("running");
    expect((await detail(hub, created.workItem.id)).agentSession).toBeNull();

    clock += 31000;
    const b = startWorker(base, "worker-b", marker, root);
    const outcome = await b.next(["agent-started", "worker-done"]);
    if (outcome.type === "agent-started")
      expect(outcome.executionId).toBe(created.execution.id);
    const state = await detail(hub, created.workItem.id);
    expect
      .soft(outcome.type, "an uncertain execution must not start another Agent")
      .not.toBe("agent-started");
    expect
      .soft(entries(marker), "the side effect must not run twice")
      .toHaveLength(1);
    expect
      .soft(state.workItem.status, "the Work Item must surface uncertainty")
      .not.toBe("active");
    expect
      .soft(
        JSON.stringify(state),
        "uncertain execution must be explicitly diagnosable",
      )
      .toMatch(/unknown|uncertain|需核实|不确定/i);
  });

  it("stops the old Agent on lease loss and does not start a concurrent Agent", async () => {
    const { hub, root, marker } = makeHub();
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    const created = await create(hub);
    const a = startWorker(base, "worker-a", marker, root);
    const first = await a.next(["agent-started"]);
    expect(first.executionId).toBe(created.execution.id);
    clock += 31000;
    const b = startWorker(base, "worker-b", marker, root);
    const outcome = await b.next(["agent-started", "worker-done"]);
    if (outcome.type === "agent-started")
      expect(outcome.executionId).toBe(created.execution.id);
    a.child.send("heartbeat");
    const response = await a.next(["heartbeat"]);
    expect(response.status).toBe(409);
    const oldStopped = await stopped(first as Agent);
    expect
      .soft(outcome.type, "lease loss must not trigger a duplicate Agent")
      .not.toBe("agent-started");
    expect
      .soft(entries(marker), "the side effect must remain single")
      .toHaveLength(1);
    expect
      .soft(
        oldStopped,
        "the old Agent should receive a stop request after loss of ownership",
      )
      .toBe(true);
  });

  it("does not retry an Agent timeout after the side effect", async () => {
    const { hub, marker } = makeHub();
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    const created = await create(hub);
    let calls = 0;
    const adapter: AgentAdapter = {
      async execute(input) {
        calls++;
        const { appendFileSync } = await import("node:fs");
        appendFileSync(
          marker,
          JSON.stringify({ executionId: input.executionId }) + "\n",
        );
        if (calls === 1) throw new AgentTimeoutError();
        return { type: "completed", sessionId: "fake-session", output: "done" };
      },
    };
    expect(await workOnce(base, "worker-a", adapter)).toBe(true);
    const afterTimeout = await detail(hub, created.workItem.id);
    clock += 3000;
    hub.tickScheduler();
    await workOnce(base, "worker-b", adapter);
    const final = await detail(hub, created.workItem.id);
    expect
      .soft(
        afterTimeout.workItem.status,
        "timeout after a side effect needs reconciliation",
      )
      .not.toBe("waiting_schedule");
    expect
      .soft(calls, "an ambiguous timeout must not invoke the Agent again")
      .toBe(1);
    expect.soft(entries(marker)).toHaveLength(1);
    expect.soft(final.executions).toHaveLength(1);
    expect
      .soft(
        JSON.stringify(afterTimeout),
        "ambiguous timeout must be explicitly diagnosable",
      )
      .toMatch(/unknown|uncertain|需核实|不确定/i);
  });

  it("retains retry when a transient failure is proved to happen before Agent startup", async () => {
    const { hub, marker } = makeHub();
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    const created = await create(hub);
    let attempts = 0;
    const adapter: AgentAdapter = {
      async execute(input) {
        attempts++;
        if (attempts === 1)
          throw new AgentExecutionError(
            "fixture pre-start failure",
            true,
            false,
            true,
          );
        const { appendFileSync } = await import("node:fs");
        appendFileSync(
          marker,
          JSON.stringify({ executionId: input.executionId }) + "\n",
        );
        return { type: "completed", sessionId: "fake-session", output: "done" };
      },
    };
    expect(await workOnce(base, "worker-a", adapter)).toBe(true);
    expect(entries(marker)).toHaveLength(0);
    expect((await detail(hub, created.workItem.id)).workItem.status).toBe(
      "waiting_schedule",
    );
    clock += 3000;
    expect(hub.tickScheduler()).toBe(1);
    expect(await workOnce(base, "worker-b", adapter)).toBe(true);
    const state = await detail(hub, created.workItem.id);
    expect(attempts).toBe(2);
    expect(entries(marker)).toHaveLength(1);
    expect(state.executions).toHaveLength(2);
    expect(state.workItem.status).toBe("completed");
  });

  it("does not retry a missing executable that could not start", async () => {
    const { hub, root, marker } = makeHub();
    const base = await hub.listen({ port: 0, host: "127.0.0.1" });
    const created = await create(hub);
    const runner = new ProcessRunner();
    const adapter: AgentAdapter = {
      async execute() {
        await runner.run({
          executable: join(root, "missing-test-agent-executable"),
          args: [],
          cwd: root,
          env: {},
          timeoutMs: 1000,
        });
        throw new Error("missing executable unexpectedly started");
      },
    };
    expect(await workOnce(base, "worker-missing", adapter)).toBe(true);
    const state = await detail(hub, created.workItem.id);
    expect(entries(marker)).toHaveLength(0);
    expect(state.executions).toHaveLength(1);
    expect(state.executions[0].error).toMatchObject({
      code: "agent_unavailable",
      retryable: false,
    });
    expect(state.workItem.status).toBe("failed");
    expect(state.schedules).toHaveLength(0);
  });
  it("rejects stale results without changing the new owner's execution or creating follow-ups", async () => {
    const { hub } = makeHub();
    const created = await create(hub);
    const first = (
      await post(hub, "/api/executions/claim", { workerId: "worker-a" })
    ).json();
    clock += 31000;
    const other = await create(hub);
    const secondResponse = await post(hub, "/api/executions/claim", {
      workerId: "worker-b",
    });
    expect(secondResponse.statusCode).toBe(200);
    const second = secondResponse.json();
    expect(second.execution.id).toBe(other.execution.id);
    expect(second.execution.id).not.toBe(first.execution.id);
    const before = await detail(hub, created.workItem.id);
    const otherBefore = await detail(hub, other.workItem.id);
    const stale = await post(
      hub,
      `/api/executions/${first.execution.id}/result`,
      {
        workerId: "worker-a",
        leaseToken: first.leaseToken,
        result: {
          type: "needs_input",
          sessionId: "stale-session",
          request: { title: "q", text: "q", key: "q", options: ["yes"] },
        },
      },
    );
    expect(stale.statusCode).toBe(409);
    const staleLater = await post(
      hub,
      `/api/executions/${first.execution.id}/result`,
      {
        workerId: "worker-a",
        leaseToken: first.leaseToken,
        result: {
          type: "later",
          sessionId: "stale-session",
          message: "later",
          afterSeconds: 2,
        },
      },
    );
    expect(staleLater.statusCode).toBe(409);
    const after = await detail(hub, created.workItem.id);
    expect(after).toEqual(before);
    expect(await detail(hub, other.workItem.id)).toEqual(otherBefore);
    expect(after.agentSession).toBeNull();
    expect(after.interactions).toHaveLength(0);
    expect(after.schedules).toHaveLength(0);
    expect(after.executions[0].status).toBe("failed");
    expect(after.executions[0].error.code).toBe("execution_outcome_unknown");
  });
});
