// Prevent human output from exposing session IDs or omitting actionable pending work.
import { describe, expect, it } from "vitest";
import {
  formatWorkItemList,
  formatWorkItem,
  formatInbox,
  formatRuntimeStatus,
  formatDoctor,
} from "../src/cli-format.js";
describe("human CLI output", () => {
  it("shows empty and populated work without truncating IDs", () => {
    expect(formatWorkItemList([])).toContain("No work items");
    expect(
      formatWorkItemList([
        {
          workItem: { id: "full-work-id", title: "Example", status: "active" },
          latestExecution: { sequence: 2 },
        },
      ]),
    ).toContain("full-work-id");
  });
  it("explains waiting, schedules, failures and completion", () => {
    const base = {
      workItem: { id: "w", title: "Task", status: "waiting_input" },
      executions: [],
      interactions: [{ id: "i", status: "open", request: { title: "Choose" } }],
      schedules: [],
    };
    expect(formatWorkItem(base)).toContain("Choose");
    expect(
      formatWorkItem({
        ...base,
        workItem: { ...base.workItem, status: "waiting_schedule" },
        schedules: [{ status: "active", nextFireAt: "2026-01-01" }],
      }),
    ).toContain("2026-01-01");
    expect(
      formatWorkItem({
        ...base,
        workItem: { ...base.workItem, status: "failed" },
        executions: [
          {
            error: {
              code: "quota_exceeded",
              message: "quota",
              retryable: false,
            },
          },
        ],
      }),
    ).toContain("quota_exceeded");
    expect(
      formatWorkItem({
        ...base,
        workItem: { ...base.workItem, status: "completed" },
        executions: [{ output: "finished" }],
      }),
    ).toContain("finished");
  });
  it("shows inbox, runtime and doctor status", () => {
    expect(formatInbox([])).toContain("Inbox is empty");
    expect(
      formatInbox([
        {
          interactionId: "full-interaction-id",
          workTitle: "Example",
          request: { title: "Choose" },
        },
      ]),
    ).toContain("full-interaction-id");
    expect(
      formatRuntimeStatus({
        runtime: { runtime: "running" },
        hub: { ok: true },
        workers: [{ state: "online" }],
        windowsStartupTask: { installed: true },
        home: "home",
      }),
    ).toContain("healthy");
    expect(
      formatRuntimeStatus({
        runtime: { runtime: "stopped" },
        hub: null,
        workers: [],
        windowsStartupTask: { installed: false },
        home: "home",
      }),
    ).toContain("unavailable");
    expect(
      formatDoctor({ node: { status: "PASS", version: "v24" } }),
    ).toContain("PASS");
  });
});
