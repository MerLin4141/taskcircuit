import { resolveCurrentStore } from "../../dist/storage/generation.js";
const wanted = process.argv[3];
try {
  await resolveCurrentStore(process.argv[2], {
    onStage: async (stage) => {
      if (stage === wanted) {
        process.send?.({ stage });
        await new Promise(() => {
          setInterval(() => {}, 1000);
        });
      }
    },
  });
  process.send?.({ stage: "unexpected-complete" });
} catch (error) {
  process.send?.({ stage: "error", code: error?.code ?? "error" });
  process.exitCode = 1;
}
