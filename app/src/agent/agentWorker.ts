import { parentPort, workerData } from "node:worker_threads";
import { runAgentPrompt } from "./core.ts";

if (!workerData) process.exit(0);

type WorkerInput = Parameters<typeof runAgentPrompt>[0] & { signal?: never };

runAgentPrompt({
  ...(workerData as WorkerInput),
  onChunk: (chunk) => {
    parentPort!.postMessage({ type: "chunk", text: chunk });
  },
})
  .then((result) => {
    parentPort!.postMessage({ type: "done", result });
  })
  .catch((error: unknown) => {
    parentPort!.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  });
