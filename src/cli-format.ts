type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const list = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string =>
  value === null || value === undefined
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value);
export function formatWatchChange(
  type: string,
  payload: { status?: string } = {},
): string {
  const labels: Record<string, string> = {
    "work_item.created": "工作已创建",
    "execution.created": "执行已排队",
    "execution.started": "执行已领取",
    "execution.completed": "一次执行已结束",
    "execution.waiting_input": "等待人工回答",
    "interaction.opened": "需要人工回答",
    "interaction.resolved": "已收到回答",
  };
  const label =
    type === "work_item.status_changed" && payload.status === "completed"
      ? "工作已完成"
      : labels[type];
  return `${label ? `${label} · ` : ""}${type}${payload.status ? ` → ${payload.status}` : ""}`;
}
export function formatWorkItemList(value: unknown): string {
  const items = list(value);
  if (!items.length) return "No work items.";
  return [
    "TaskCircuit Work Items",
    "",
    ...items.map((item) => {
      const w = row(item.workItem),
        e = row(item.latestExecution);
      return `${text(w.id)}  ${text(w.status)}  ${text(w.title)}  agent: ${text(w.agentProfileId)}  execution: ${text(e.sequence)}  updated: ${text(w.updatedAt)}`;
    }),
    "",
    `${items.length} work items`,
  ].join("\n");
}
export function formatWorkItem(value: unknown): string {
  const d = row(value),
    w = row(d.workItem),
    profile = row(d.agentProfile),
    execs = list(d.executions),
    last = execs.at(-1) ?? {},
    session = row(d.agentSession);
  const out = [
    "Work Item",
    `ID:      ${text(w.id)}`,
    `Title:   ${text(w.title)}`,
    `Status:  ${text(w.status)}`,
    `Agent:   ${text(profile.id ?? w.agentProfileId)}`,
    `Created: ${text(w.createdAt)}`,
    `Updated: ${text(w.updatedAt)}`,
    "",
    "Executions",
    ...execs.map(
      (e) =>
        `#${text(e.sequence)}  ${text(e.status)}  ${text(e.triggerKind)}  ${text(e.startedAt)} → ${text(e.finishedAt)}`,
    ),
  ];
  if (session.id)
    out.push(
      "",
      "Agent Session",
      `Adapter: ${text(session.adapter)}`,
      `Session: ${text(session.id)}`,
      "External session: " + (session.externalSessionId ? "present" : "—"),
    );
  if (w.status === "waiting_input") {
    const q = list(d.interactions).find((x) => x.status === "open");
    if (q) {
      const request = row(q.request);
      out.push(
        "",
        "Waiting",
        `Interaction: ${text(q.id)}`,
        `Question: ${text(request.text ?? request.title)}`,
      );
    }
  }
  if (w.status === "waiting_schedule") {
    const schedule = list(d.schedules).find((x) => x.status === "active");
    if (schedule)
      out.push(
        "",
        "Scheduled continuation",
        `Reason: ${text(schedule.reason)}`,
        `Next: ${text(schedule.nextFireAt)}`,
      );
  }
  if (
    (w.status === "failed" ||
      w.status === "waiting_schedule" ||
      w.status === "cancelled") &&
    last.error
  ) {
    const e = row(last.error);
    out.push(
      "",
      "Last Error",
      `Code: ${text(e.code)}`,
      `Retryable: ${e.retryable === true ? "yes" : "no"}`,
      text(e.message ?? last.error),
    );
    if (e.code === "execution_outcome_unknown")
      out.push(
        "执行结果需要核实。Agent 可能已经执行了外部操作。",
        "系统不会自动重新执行；请核实外部结果后再决定如何处理。",
      );
  }
  if (
    w.status === "completed" &&
    last.output !== undefined &&
    last.output !== null
  )
    out.push("", "Result", text(last.output));
  return out.join("\n");
}
export function formatInbox(value: unknown): string {
  const items = list(value);
  if (!items.length) return "Inbox is empty.";
  return [
    "TaskCircuit Inbox",
    ...items.map((item, i) => {
      const request = row(item.request);
      const id = text(item.interactionId);
      return `\n[${i + 1}] ${text(item.workTitle)}\nWork ID: ${text(item.workItemId)}\nInteraction: ${id}\nQuestion: ${text(request.text ?? request.title)}\nOptions: ${Array.isArray(request.options) ? request.options.join(" / ") : "—"}\nAnswer with: taskcircuit answer ${id} "<answer>"`;
    }),
  ].join("\n");
}
export function formatRuntimeStatus(value: unknown): string {
  const d = row(value),
    task = row(d.windowsStartupTask),
    runtime = row(d.runtime),
    hub = row(d.hub),
    workers = list(d.workers),
    stale = workers.filter((w) => w.state === "stale").length;
  return [
    "TaskCircuit Runtime",
    "",
    "Startup Task",
    `  Installed: ${task.installed ? "yes" : "no"}`,
    `  Name: ${text(task.name)}`,
    `  State: ${text(task.state)}`,
    "",
    "Launcher",
    `  State: ${text(runtime.runtime)}`,
    `  PID: ${text(runtime.launcherPid)}`,
    "",
    "Hub",
    `  Status: ${hub.ok ? "healthy" : "unavailable"}`,
    "",
    "Workers",
    `  Online: ${workers.filter((w) => w.state === "online").length}`,
    `  Stale: ${stale}`,
    ...(stale ? [`Warning: ${stale} stale worker presence record(s).`] : []),
    ...(hub.ok ? [] : ["Run `taskcircuit doctor` for diagnostics."]),
    "",
    "Home",
    `  ${text(d.home)}`,
  ].join("\n");
}
export function formatDoctor(value: unknown): string {
  return [
    "TaskCircuit Doctor",
    "",
    ...Object.entries(row(value)).map(([key, v]) => {
      const check = row(v);
      const detail =
        key === "hub" && check.status === "PASS"
          ? "healthy"
          : key === "workers" && Array.isArray(check.detail)
            ? `${list(check.detail).filter((w) => w.state === "online").length} online`
            : undefined;
      return `[${text(check.status)}] ${key}  ${text(check.message ?? check.version ?? check.path ?? detail)}`;
    }),
  ].join("\n");
}
