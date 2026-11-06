import { workOnce } from "../dist/worker.js";
try {
  const worked = await workOnce(process.argv[2], "e2e-worker");
  if (!worked) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : "worker failed");
  process.exitCode = 1;
}
