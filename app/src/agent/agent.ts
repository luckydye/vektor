import { Worker } from "node:worker_threads";
import type { AgentEvent, AgentResult, ChatMessage } from "./core.ts";

export type { AgentResult, ChatMessage };
export type { AgentEvent };
export { runAgentPrompt } from "./core.ts";

type WorkerMessage =
  | { type: "event"; event: AgentEvent }
  | { type: "done"; result: AgentResult }
  | { type: "error"; message: string };

export async function runAgentInWorker(options: {
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentResult> {
  const { signal, onEvent, ...workerInput } = options;

  return new Promise((resolve, reject) => {
    const worker = new Worker("./src/agent/agentWorker.ts", { workerData: workerInput });

    const abort = () => {
      worker.terminate();
      reject(new Error("Agent request cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.type === "event") {
        void onEvent?.(msg.event);
      } else if (msg.type === "done") {
        signal?.removeEventListener("abort", abort);
        resolve(msg.result);
      } else if (msg.type === "error") {
        signal?.removeEventListener("abort", abort);
        reject(new Error(msg.message));
      }
    });

    worker.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });

    worker.on("exit", (code) => {
      if (code !== 0) {
        signal?.removeEventListener("abort", abort);
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}
