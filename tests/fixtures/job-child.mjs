import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
await new Promise((r) => process.stdin.once("data", r));
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
mkdirSync(process.env.TASKCIRCUIT_HOME, { recursive: true });
writeFileSync(
  join(process.env.TASKCIRCUIT_HOME, "ids.json"),
  JSON.stringify({ parent: process.pid, child: child.pid }),
);
setInterval(() => {}, 1000);
