import type { AgentSpace } from "#agent/tools.ts";
import type { AIProvider, ChatMessage } from "#api/provider/types.ts";
import { appLogger } from "#observability/logger.ts";
import {
  type AgentEvent,
  type AgentResult,
  AgentTurnError,
  type AgentTurnSetup,
  type SettleAITokens,
} from "./core.ts";
import { mainThreadAgentHost } from "./host.ts";
import { getIntegrationAgentSurface } from "./integrations.ts";
import type {
  AgentHostCall,
  AgentWorkerProvider,
  AgentWorkerRequest,
  AgentWorkerResponse,
} from "./worker.ts";

export type { AgentEvent, AgentResult, AgentTurnSetup, ChatMessage };

/**
 * The main thread's side of the agent worker (`worker.ts`). Turns run there,
 * one worker for all of them so a session's shell stays where its turns run;
 * this side forwards their events and answers what they need from the
 * databases and the job scheduler.
 */

type PendingTurn = {
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onSetup?: (setup: AgentTurnSetup) => void;
  /** Answers the worker's token requests for an integration provider. */
  provider?: AIProvider;
};

let worker: Worker | null = null;
let nextTurnId = 1;
let nextReservationId = 1;
const turns = new Map<number, PendingTurn>();
/** Token reservations a worker made and has yet to settle. */
const reservations = new Map<number, SettleAITokens>();

function getWorker(): Worker {
  if (worker) return worker;
  // In the compiled binary every module's import.meta.url is the binary's own
  // (`$bunfs/root/vektor`), and build.ts embeds the worker entrypoint under its
  // path from the build root.
  const workerUrl = import.meta.url.includes("$bunfs")
    ? new URL("./src/agent/worker.ts", import.meta.url)
    : new URL("./worker.ts", import.meta.url);
  const spawned = new Worker(workerUrl, { type: "module" });
  spawned.addEventListener("message", (event: MessageEvent<AgentWorkerResponse>) =>
    handleWorkerMessage(spawned, event.data),
  );
  // The sessions' shells die with the worker; each session's next turn
  // restores its shell from the snapshot saved with the session.
  const fail = (reason: string) => {
    if (worker !== spawned) return;
    worker = null;
    spawned.terminate();
    reservations.clear();
    for (const [turnId, turn] of turns) {
      turns.delete(turnId);
      turn.reject(new Error(reason));
    }
  };
  spawned.addEventListener("error", (event) => {
    appLogger.error("Agent worker crashed", { message: event.message });
    fail(`Agent worker crashed: ${event.message}`);
  });
  // A worker can also end without an error; its turns would otherwise never settle.
  spawned.addEventListener("close", () => fail("Agent worker exited"));
  // An idle worker must not keep a CLI or test process alive.
  spawned.unref();
  worker = spawned;
  return spawned;
}

export function stopAgentWorker(): void {
  const stopping = worker;
  worker = null;
  stopping?.terminate();
}

function handleWorkerMessage(source: Worker, message: AgentWorkerResponse): void {
  if (message.type === "hostCall") {
    void answerHostCall(source, message);
    return;
  }

  const turn = turns.get(message.turnId);
  if (!turn) throw new Error(`Agent worker reported unknown turn ${message.turnId}`);

  if (message.type === "event") {
    void turn.onEvent?.(message.event);
  } else if (message.type === "setup") {
    turn.onSetup?.(message.setup);
  } else if (message.type === "done") {
    turns.delete(message.turnId);
    turn.resolve(message.result);
  } else {
    turns.delete(message.turnId);
    if (message.aborted) {
      const error = new Error(message.error);
      error.name = "AbortError";
      turn.reject(error);
    } else if (message.messages) {
      turn.reject(new AgentTurnError(message.error, message.messages));
    } else {
      turn.reject(new Error(message.error));
    }
  }
}

async function answerHostCall(
  source: Worker,
  message: { callId: number } & AgentHostCall,
): Promise<void> {
  const request: AgentWorkerRequest = await callHost(message).then(
    (value) => ({ type: "hostResult", callId: message.callId, ok: true, value }),
    (error: unknown) => ({
      type: "hostResult",
      callId: message.callId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  source.postMessage(request);
}

async function callHost(call: AgentHostCall): Promise<unknown> {
  switch (call.method) {
    case "reserveAITokens": {
      const settle = await mainThreadAgentHost.reserveAITokens(...call.args);
      const reservationId = nextReservationId++;
      reservations.set(reservationId, settle);
      return reservationId;
    }
    case "settleAITokens": {
      const [reservationId, actualTokens] = call.args;
      const settle = reservations.get(reservationId);
      if (!settle) throw new Error(`Unknown token reservation ${reservationId}`);
      reservations.delete(reservationId);
      await settle(actualTokens);
      return null;
    }
    case "runIntegrationCommand":
      return mainThreadAgentHost.runIntegrationCommand(...call.args);
    case "integrationAccessToken": {
      const provider = turns.get(call.args[0])?.provider;
      if (provider?.provider !== "integration") {
        throw new Error(`Turn ${call.args[0]} has no integration provider`);
      }
      return provider.accessToken();
    }
  }
}

/** An integration provider's token stays here; the worker asks for it per call. */
function toWorkerProvider(provider?: AIProvider): AgentWorkerProvider | undefined {
  if (provider?.provider !== "integration") return provider;
  const { accessToken: _accessToken, ...data } = provider;
  return data;
}

/** Runs one agent turn in the agent worker. */
export async function runAgentInWorker(options: {
  chatId: string;
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  connectedProviders: string[];
  userProfile?: string;
  timeZone?: string;
  systemPrompt?: string;
  userId?: string | null;
  provider?: AIProvider;
  jobToken: string;
  /** Every space the turn works in, `spaceId` included, when there are several. */
  spaces?: AgentSpace[];
  shellSnapshot?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  onSetup?: (setup: AgentTurnSetup) => void;
}): Promise<AgentResult> {
  const { signal, onEvent, onSetup, provider, ...request } = options;
  const integrationSurface = await getIntegrationAgentSurface(
    options.spaceId,
    options.connectedProviders,
  );
  signal?.throwIfAborted();

  const turnId = nextTurnId++;
  const target = getWorker();
  const abort = () => target.postMessage({ type: "abort", turnId });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await new Promise<AgentResult>((resolve, reject) => {
      turns.set(turnId, { resolve, reject, onEvent, onSetup, provider });
      const message: AgentWorkerRequest = {
        type: "run",
        turnId,
        request: {
          ...request,
          integrationSurface,
          provider: toWorkerProvider(provider),
        },
      };
      target.postMessage(message);
    });
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
