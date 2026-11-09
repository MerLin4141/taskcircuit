// A local-only process that records a side effect before waiting for test cleanup.
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

const [markerPath, workItemId, executionId, session] = process.argv.slice(2);
const token = randomBytes(16).toString("hex");
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.once("data", (value) => {
    if (String(value).trim() === token + ":status") {
      socket.end("running");
    } else if (String(value).trim() === token) {
      socket.end("stopping");
      server.close(() => process.exit(0));
    } else socket.end("rejected");
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const entry = {
    pid: process.pid,
    port: address.port,
    token,
    workItemId,
    executionId,
    session,
  };
  appendFileSync(markerPath, JSON.stringify(entry) + "\n");
  process.send?.({ type: "agent-started", ...entry });
});
process.on("message", (message) => {
  if (message === "stop") server.close(() => process.exit(0));
});

process.on("disconnect", () => {});
