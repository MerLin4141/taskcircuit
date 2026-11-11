import { appendFileSync } from "node:fs";

export default function activeFixture() {
  return {
    manifest: {
      id: "fixture-source",
      kind: "source",
      apiVersion: 2,
      version: "1",
    },
    createSource(config, host) {
      return {
        async start(signal) {
          appendFileSync(config.trace, "start\n");
          await host
            .submit({
              sourceEventId: "before-ready",
              type: "fixture.event",
              payload: {},
            })
            .then(
              () => {
                throw new Error("submission accepted during startup");
              },
              (error) => {
                if (error.code !== "source_unavailable") throw error;
              },
            );
          signal.addEventListener(
            "abort",
            () => appendFileSync(config.trace, "abort\n"),
            { once: true },
          );
          if (config.failStart) throw new Error("private startup detail");
          if (config.hangStart) {
            process.send?.({ type: "fixture-starting" });
            await new Promise(() => {});
          }
        },
        async stop() {
          appendFileSync(config.trace, "stop\n");
        },
      };
    },
  };
}
