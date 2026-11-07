// Prevent subcommand help from failing or contacting a running Hub.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("CLI help", () => {
  for (const [command, expected] of [
    ["runtime", "install"],
    ["schedule", "list"],
  ]) {
    it(`shows ${command} help without a Hub`, () => {
      const output = execFileSync(
        process.execPath,
        ["dist/cli.js", command, "--help"],
        { encoding: "utf8" },
      );
      expect(output).toContain(expected);
    });
  }
});
