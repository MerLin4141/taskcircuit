import { createHub } from "../../dist/hub.js";
import { defaultConfig } from "../../dist/config.js";
const hub = createHub(
  process.argv[2],
  defaultConfig,
  () => Number(process.argv[3]),
  0,
);
process.send?.("ready");
process.on("message", async () => {
  try {
    const count = hub.tickScheduler();
    process.send?.({ count });
  } catch (error) {
    process.send?.({ error: String(error) });
  } finally {
    await hub.close();
    process.disconnect?.();
  }
});
