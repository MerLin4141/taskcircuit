import { readFileSync } from "node:fs";
const [path, kind, scenario, ...args] = process.argv.slice(2);
const fixtures = JSON.parse(readFileSync(path, "utf8"));
if (scenario === "hang") {
  setInterval(() => {}, 1000);
} else if (scenario === "nonzero" || scenario.startsWith("error-")) {
  process.stderr.write(
    fixtures.errors[scenario === "nonzero" ? "unknown" : scenario.slice(6)],
  );
  process.exitCode = 9;
} else if (scenario === "help") {
  process.stdout.write(fixtures.help[kind]);
} else {
  if (kind === "codex" && (!args.includes("exec") || !args.includes("--json")))
    process.exitCode = 4;
  else if (
    kind === "claude" &&
    (!args.includes("--print") || !args.includes("--output-format"))
  )
    process.exitCode = 4;
  else {
    process.stderr.write("synthetic-stderr-private-marker");
    process.stdout.write(fixtures[kind][scenario]);
  }
}
