const args = process.argv.slice(2);
const message = JSON.stringify({
  kind: "complete",
  message: "fixture complete",
});
if (args.includes("exec")) {
  console.log(
    JSON.stringify({ type: "thread.started", thread_id: "fixture-id" }),
  );
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: message },
    }),
  );
} else
  console.log(JSON.stringify({ session_id: "fixture-id", result: message }));
