import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { TaskCircuitError } from "./domain.js";
import { loopConfig, parseDuration } from "./loop-limits.js";
import { CAPABILITIES } from "./policy-core.js";
import { resultDigest } from "./result-receipt.js";

type Obj = Record<string, unknown>;
type Action = "create" | "version" | "unchanged" | "conflict" | "invalid";
type Change = {
  automation: string;
  action: Action;
  fromVersion: number | null;
  toVersion: number | null;
  reason?: string;
};
type Compiled = { id: string; snapshot: Obj };
const obj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v);
const invalid = (message: string): never => {
  throw new TaskCircuitError("apply_invalid", message, 400);
};
const exact = (v: Obj, keys: string[]) => {
  if (Object.keys(v).some((key) => !keys.includes(key)))
    invalid("规则包含未知字段");
};
function compile(
  input: unknown,
  config: Config,
): { documentId: string; rules: Compiled[]; invalidRules: Change[] } {
  if (!obj(input)) return invalid("规则文档格式不正确");
  exact(input, ["schemaVersion", "id", "rules"]);
  if (
    input.schemaVersion !== 1 ||
    !validId(input.id) ||
    !Array.isArray(input.rules)
  )
    return invalid("规则文档格式不正确");
  const documentId = input.id;
  const names = new Set<string>();
  const compileRule = (entry: unknown): Compiled => {
    if (!obj(entry)) return invalid("规则格式不正确");
    exact(entry, [
      "name",
      "when",
      "agent",
      "workspace",
      "instruction",
      "loop",
      "notify",
      "notifyOnCompleted",
    ]);
    if (
      !validId(entry.name) ||
      names.has(entry.name) ||
      !obj(entry.when) ||
      typeof entry.agent !== "string" ||
      typeof entry.workspace !== "string" ||
      (entry.instruction !== undefined && typeof entry.instruction !== "string")
    )
      return invalid("规则字段不正确");
    const name = entry.name;
    names.add(name);
    exact(entry.when, ["source", "type"]);
    if (
      entry.when.source !== "local" ||
      typeof entry.when.type !== "string" ||
      entry.when.type.length > 128 ||
      !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(entry.when.type)
    )
      return invalid("事件来源或类型未注册");
    const agent = entry.agent;
    const workspace = entry.workspace;
    const eventType = entry.when.type;
    const matches = config.routes.filter(
      (r) => r.event.source === "local" && r.event.type === eventType,
    );
    if (
      !Object.hasOwn(config.agents, agent) ||
      matches.length !== 1 ||
      matches[0].agent !== agent
    )
      return invalid("Agent 或事件路由未在可信配置中注册，或路由存在歧义");
    if (
      !config.policyWorkspaces ||
      !Object.hasOwn(config.policyWorkspaces, workspace)
    )
      return invalid("工作目录未在可信配置中注册");
    const ws = config.policyWorkspaces[workspace];
    try {
      if (!isAbsolute(ws.path) || !isAbsolute(ws.allowedRoot))
        return invalid("工作目录无效");
      const base = realpathSync(ws.allowedRoot),
        path = realpathSync(ws.path),
        rel = relative(base, path);
      if (
        !statSync(base).isDirectory() ||
        !statSync(path).isDirectory() ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      )
        return invalid("工作目录无效");
    } catch (error) {
      if (error instanceof TaskCircuitError) throw error;
      return invalid("工作目录无效");
    }
    if (
      !Array.isArray(ws.allowedCapabilities) ||
      ws.allowedCapabilities.some(
        (c) =>
          !CAPABILITIES.includes(c as (typeof CAPABILITIES)[number]) ||
          c === "external_action",
      )
    )
      return invalid("工作目录权限配置无效");
    const loop = entry.loop === undefined ? {} : entry.loop;
    if (!obj(loop)) return invalid("循环配置无效");
    exact(loop, ["maxRuns", "deadline"]);
    if (loop.deadline !== undefined && typeof loop.deadline !== "string")
      return invalid("期限格式不正确");
    const maxDurationSeconds =
      loop.deadline === undefined
        ? 7200
        : parseDuration(loop.deadline as string);
    const loopSnapshot = {
      maxRuns: loop.maxRuns === undefined ? 8 : loop.maxRuns,
      maxDurationSeconds,
    };
    loopConfig({ loop: loopSnapshot });
    const channelIds = config.channels ?? { local: { type: "local-console" } };
    if (
      entry.notify !== undefined &&
      (!Array.isArray(entry.notify) ||
        entry.notify.some(
          (x) => typeof x !== "string" || !Object.hasOwn(channelIds, x),
        ) ||
        new Set(entry.notify).size !== entry.notify.length)
    )
      return invalid("通知通道无效");
    if (
      entry.notifyOnCompleted !== undefined &&
      typeof entry.notifyOnCompleted !== "boolean"
    )
      return invalid("通知配置无效");
    return {
      id: name,
      snapshot: {
        instruction: entry.instruction ?? "",
        loop: loopSnapshot,
        policy: {
          effect: "authorize",
          eventTypes: [eventType],
          agentProfileId: agent,
          agentProfileSnapshot: config.agents[agent],
          workspaceId: workspace,
          workspacePath: ws.path,
          workspaceAllowedRoot: ws.allowedRoot,
          allowedCapabilities: ws.allowedCapabilities,
          requestedCapabilities: ws.allowedCapabilities,
          requiresApproval: false,
          sourceInstance: "local-cli",
          sourceTrustContext: "trusted_local_cli",
        },
        ...(entry.notify === undefined ? {} : { notify: entry.notify }),
        ...(entry.notifyOnCompleted === undefined
          ? {}
          : { notifyOnCompleted: entry.notifyOnCompleted }),
        management: {
          kind: "taskcircuit.apply",
          schemaVersion: 1,
          documentId,
          ruleName: name,
        },
      },
    };
  };
  const rules: Compiled[] = [];
  const invalidRules: Change[] = [];
  input.rules.forEach((entry, index) => {
    try {
      rules.push(compileRule(entry));
    } catch (error) {
      if (!(error instanceof TaskCircuitError)) throw error;
      invalidRules.push({
        automation:
          obj(entry) && validId(entry.name)
            ? entry.name
            : `<invalid-${index + 1}>`,
        action: "invalid",
        fromVersion: null,
        toVersion: null,
        reason: error.message,
      });
    }
  });
  rules.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { documentId, rules, invalidRules };
}
function makePlan(
  db: DatabaseSync,
  compiled: ReturnType<typeof compile>,
): Change[] {
  const changes: Change[] = compiled.rules.map(({ id, snapshot }) => {
    const row = db
      .prepare(
        "SELECT d.current_version,v.config_snapshot_json FROM automation_definitions d JOIN automation_definition_versions v ON v.definition_id=d.id AND v.version=d.current_version WHERE d.id=?",
      )
      .get(id);
    if (!row)
      return {
        automation: id,
        action: "create",
        fromVersion: null,
        toVersion: 1,
      };
    let previous: unknown;
    try {
      previous = JSON.parse(String(row.config_snapshot_json));
    } catch {
      return {
        automation: id,
        action: "conflict",
        fromVersion: Number(row.current_version),
        toVersion: null,
      };
    }
    const marker =
      obj(previous) && obj(previous.management) ? previous.management : null;
    if (
      !marker ||
      marker.kind !== "taskcircuit.apply" ||
      marker.schemaVersion !== 1 ||
      marker.documentId !== compiled.documentId ||
      marker.ruleName !== id
    )
      return {
        automation: id,
        action: "conflict",
        fromVersion: Number(row.current_version),
        toVersion: null,
      };
    const current = Number(row.current_version);
    return resultDigest(previous) === resultDigest(snapshot)
      ? {
          automation: id,
          action: "unchanged",
          fromVersion: current,
          toVersion: current,
        }
      : {
          automation: id,
          action: "version",
          fromVersion: current,
          toVersion: current + 1,
        };
  });
  return [...changes, ...compiled.invalidRules].sort((a, b) =>
    a.automation < b.automation ? -1 : a.automation > b.automation ? 1 : 0,
  );
}
export function applyDocument(
  db: DatabaseSync,
  config: Config,
  input: unknown,
  dryRun: boolean,
  now: () => number,
  onStage?: () => void,
) {
  const compiled = compile(input, config);
  const apply = () => {
    const changes = makePlan(db, compiled);
    const blocked = changes.some(
      (c) => c.action === "conflict" || c.action === "invalid",
    );
    if (!dryRun && !blocked) {
      const at = new Date(now()).toISOString();
      for (const change of changes) {
        const snapshot = compiled.rules.find(
          (r) => r.id === change.automation,
        )!.snapshot;
        if (change.action === "create") {
          db.prepare(
            "INSERT INTO automation_definitions VALUES(?,?,'enabled',1,?,?)",
          ).run(change.automation, change.automation, at, at);
          db.prepare(
            "INSERT INTO automation_definition_versions VALUES(?,1,1,?,NULL,?)",
          ).run(change.automation, JSON.stringify(snapshot), at);
          onStage?.();
        } else if (change.action === "version") {
          db.prepare(
            "INSERT INTO automation_definition_versions VALUES(?,?,1,?,NULL,?)",
          ).run(
            change.automation,
            change.toVersion!,
            JSON.stringify(snapshot),
            at,
          );
          db.prepare(
            "UPDATE automation_definitions SET current_version=?,updated_at=? WHERE id=?",
          ).run(change.toVersion!, at, change.automation);
          onStage?.();
        }
      }
    }
    return {
      documentId: compiled.documentId,
      dryRun,
      applied: !dryRun && !blocked,
      changes,
      summary: {
        create: changes.filter((c) => c.action === "create").length,
        version: changes.filter((c) => c.action === "version").length,
        unchanged: changes.filter((c) => c.action === "unchanged").length,
        conflict: changes.filter((c) => c.action === "conflict").length,
        invalid: changes.filter((c) => c.action === "invalid").length,
      },
    };
  };
  db.exec(dryRun ? "BEGIN" : "BEGIN IMMEDIATE");
  try {
    const result = apply();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
