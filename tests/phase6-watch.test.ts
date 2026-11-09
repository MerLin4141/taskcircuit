// Guards watch output from presenting lease acquisition as proof that an Agent ran.
import { expect, it } from "vitest";
import { formatWatchChange } from "../src/cli-format.js";
it("renders known changes in plain language while preserving the event type", () => {
  expect(
    formatWatchChange("execution.started", { status: "running" }),
  ).toContain("执行已领取");
  expect(
    formatWatchChange("work_item.status_changed", { status: "completed" }),
  ).toContain("工作已完成");
  expect(
    formatWatchChange("execution.completed", { status: "completed" }),
  ).not.toContain("任务已完成");
  expect(formatWatchChange("interaction.opened", {})).toContain(
    "interaction.opened",
  );
});
