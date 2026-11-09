import { createHub } from "./v012-runtime/hub.js";
import { defaultConfig } from "./v012-runtime/config.js";
const hub = createHub(
  process.argv[2],
  defaultConfig,
  () => Number(process.argv[3]),
  0,
  { dispatcherPollMs: 0 },
);
const base = await hub.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ type: "ready", base });
process.on("message", async (m) => {
  if (m === "tick") {
    process.send?.({ type: "tick-start" });
    try {
      process.send?.({ type: "tick-end", count: hub.tickScheduler() });
    } catch (e) {
      process.send?.({
        type: "tick-error",
        marker: String(e.message).includes("taskcircuit_database_upgraded"),
      });
    }
  } else if (m === "stop") {
    await hub.close();
    process.disconnect?.();
  }
});
