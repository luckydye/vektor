/// <reference lib="webworker" />
import { gunzipSync, gzipSync } from "node:zlib";
import type { Bash } from "just-bash";
import type { AgentSpace, VektorMcpConfig } from "#agent/tools.ts";
import type {
  ChatMessage,
  InstanceAIProvider,
  IntegrationAIProvider,
} from "#api/provider/types.ts";
import {
  type AgentEvent,
  type AgentHost,
  type AgentResult,
  AgentTurnError,
  type AgentTurnSetup,
  createAgentShell,
  runAgentPrompt,
} from "./core.ts";
import type { IntegrationAgentSurface } from "./integrations.ts";

/**
 * Agent worker: runs agent turns off the main event loop — the model loop, the
 * emulated shell with its js-exec, and the shell snapshots — and holds the
 * sessions' shells between turns. What needs the space databases or the job
 * scheduler it asks the main thread for, through `AgentHost`.
 */

/** A provider as it crosses to the worker; an integration's token is fetched per call. */
export type AgentWorkerProvider =
  | InstanceAIProvider
  | Omit<IntegrationAIProvider, "accessToken">;

/** A turn's options as they cross to the worker: data only. */
export type AgentTurnRequest = {
  chatId: string;
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  connectedProviders: string[];
  /** What the connected integrations add, resolved on the main thread. */
  integrationSurface: IntegrationAgentSurface;
  userProfile?: string;
  timeZone?: string;
  systemPrompt?: string;
  userId?: string | null;
  provider?: AgentWorkerProvider;
  jobToken: string;
  spaces?: AgentSpace[];
  shellSnapshot?: string | null;
};

export type AgentHostCall =
  | { method: "reserveAITokens"; args: [spaceId: string, inputTokens: number] }
  | {
      method: "settleAITokens";
      args: [reservationId: number, actualTokens: number | undefined];
    }
  | {
      method: "runIntegrationCommand";
      args: [Parameters<AgentHost["runIntegrationCommand"]>[0]];
    }
  | { method: "integrationAccessToken"; args: [turnId: number] };

export type AgentWorkerRequest =
  | { type: "run"; turnId: number; request: AgentTurnRequest }
  | { type: "abort"; turnId: number }
  | { type: "hostResult"; callId: number; ok: true; value: unknown }
  | { type: "hostResult"; callId: number; ok: false; error: string };

export type AgentWorkerResponse =
  | { type: "event"; turnId: number; event: AgentEvent }
  | { type: "setup"; turnId: number; setup: AgentTurnSetup }
  | { type: "done"; turnId: number; result: AgentResult }
  | {
      type: "failed";
      turnId: number;
      error: string;
      aborted: boolean;
      /** The messages a failed turn produced, when it got as far as the model. */
      messages: ChatMessage[] | null;
    }
  | ({ type: "hostCall"; callId: number } & AgentHostCall);

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<AgentWorkerRequest>) => void) | null;
  postMessage: (message: AgentWorkerResponse) => void;
};

type AgentSession = {
  bash: Bash;
  mcpConfigRef: { current: VektorMcpConfig };
  connectedProviders: string[];
  /** Fixed at the session's first turn, like its system prompt. */
  integrationSurface: IntegrationAgentSurface;
  updatedAt: number;
};

type SerializedShellEntry =
  | {
      path: string;
      type: "file";
      contentBase64: string;
      mode: number;
      mtime: number;
    }
  | {
      path: string;
      type: "directory";
      mode: number;
      mtime: number;
    }
  | {
      path: string;
      type: "symlink";
      target: string;
      mode: number;
      mtime: number;
    };

type SerializedShellState = {
  version: 1;
  cwd: string;
  env: Record<string, string>;
  entries: SerializedShellEntry[];
};

const sessionStore = new Map<string, AgentSession>();
const SESSION_TTL_MS = 1000 * 60 * 60;

function getSessionKey(options: {
  chatId: string;
  spaceId: string;
  documentId?: string;
}): string {
  return `${options.spaceId}:${options.documentId ?? ""}:${options.chatId}`;
}

function sweepExpiredSessions(now: number) {
  for (const [key, session] of sessionStore.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessionStore.delete(key);
    }
  }
}

async function captureShellState(bash: Bash): Promise<string> {
  const entries: SerializedShellEntry[] = [];
  for (const path of bash.fs.getAllPaths().sort()) {
    const stat = await bash.fs.lstat(path);
    const mtime = stat.mtime.getTime();
    if (stat.isSymbolicLink) {
      entries.push({
        path,
        type: "symlink",
        target: await bash.fs.readlink(path),
        mode: stat.mode,
        mtime,
      });
      continue;
    }
    if (stat.isDirectory) {
      entries.push({
        path,
        type: "directory",
        mode: stat.mode,
        mtime,
      });
      continue;
    }
    entries.push({
      path,
      type: "file",
      contentBase64: Buffer.from(await bash.fs.readFileBuffer(path)).toString("base64"),
      mode: stat.mode,
      mtime,
    });
  }

  const state: SerializedShellState = {
    version: 1,
    cwd: bash.getCwd(),
    env: bash.getEnv(),
    entries,
  };
  return gzipSync(Buffer.from(JSON.stringify(state), "utf-8")).toString("base64");
}

function parseShellState(snapshot: string): SerializedShellState {
  return JSON.parse(
    gunzipSync(Buffer.from(snapshot, "base64")).toString("utf-8"),
  ) as SerializedShellState;
}

async function restoreShellState(bash: Bash, state: SerializedShellState) {
  const sortedEntries = [...state.entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  for (const entry of sortedEntries) {
    if (entry.type === "directory") {
      await bash.fs.mkdir(entry.path, { recursive: true });
      await bash.fs.chmod(entry.path, entry.mode);
      await bash.fs.utimes(entry.path, new Date(entry.mtime), new Date(entry.mtime));
      continue;
    }
    if (entry.type === "symlink") {
      await bash.fs.symlink(entry.target, entry.path);
      await bash.fs.chmod(entry.path, entry.mode);
      await bash.fs.utimes(entry.path, new Date(entry.mtime), new Date(entry.mtime));
      continue;
    }
    await bash.fs.writeFile(
      entry.path,
      Buffer.from(entry.contentBase64, "base64"),
      "binary",
    );
    await bash.fs.chmod(entry.path, entry.mode);
    await bash.fs.utimes(entry.path, new Date(entry.mtime), new Date(entry.mtime));
  }
}

async function getOrCreateSession(options: AgentTurnRequest): Promise<AgentSession> {
  const now = Date.now();
  sweepExpiredSessions(now);
  const key = getSessionKey(options);
  const existing = sessionStore.get(key);
  if (existing) {
    existing.mcpConfigRef.current = {
      apiUrl: options.apiUrl,
      spaceId: options.spaceId,
      jobToken: options.jobToken,
      documentId: options.documentId,
      connectedProviders: options.connectedProviders,
    };
    existing.updatedAt = now;
    return existing;
  }

  const parsedShellState = options.shellSnapshot
    ? parseShellState(options.shellSnapshot)
    : null;
  const mcpConfigRef = {
    current: {
      apiUrl: options.apiUrl,
      spaceId: options.spaceId,
      jobToken: options.jobToken,
      documentId: options.documentId,
      connectedProviders: options.connectedProviders,
    } satisfies VektorMcpConfig,
  };
  const session: AgentSession = {
    bash: createAgentShell(mcpConfigRef, {
      cwd: parsedShellState?.cwd,
      env: parsedShellState?.env,
      integrationCommands: options.integrationSurface.commands,
      userId: options.userId ?? null,
      host: workerHost,
    }),
    mcpConfigRef,
    connectedProviders: options.connectedProviders,
    integrationSurface: options.integrationSurface,
    updatedAt: now,
  };
  sessionStore.set(key, session);
  if (parsedShellState) {
    await restoreShellState(session.bash, parsedShellState);
  }
  return session;
}

// Main-thread calls

let nextCallId = 1;
const hostCalls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function callHost<T>(call: AgentHostCall): Promise<T> {
  const callId = nextCallId++;
  return new Promise<T>((resolve, reject) => {
    hostCalls.set(callId, { resolve: resolve as (value: unknown) => void, reject });
    ctx.postMessage({ type: "hostCall", callId, ...call });
  });
}

const workerHost: AgentHost = {
  async reserveAITokens(spaceId, inputTokens) {
    const reservationId = await callHost<number>({
      method: "reserveAITokens",
      args: [spaceId, inputTokens],
    });
    return (actualTokens) =>
      callHost<void>({ method: "settleAITokens", args: [reservationId, actualTokens] });
  },
  runIntegrationCommand(request) {
    return callHost({ method: "runIntegrationCommand", args: [request] });
  },
};

// Turns

const turnControllers = new Map<number, AbortController>();

async function runTurn(turnId: number, request: AgentTurnRequest): Promise<void> {
  const controller = new AbortController();
  turnControllers.set(turnId, controller);
  try {
    const session = await getOrCreateSession(request);
    const { provider } = request;
    const result = await runAgentPrompt({
      ...request,
      provider:
        provider?.provider === "integration"
          ? {
              ...provider,
              accessToken: () =>
                callHost<string>({ method: "integrationAccessToken", args: [turnId] }),
            }
          : provider,
      connectedProviders: session.connectedProviders,
      integrationSurface: session.integrationSurface,
      host: workerHost,
      bash: session.bash,
      signal: controller.signal,
      onEvent: (event) => ctx.postMessage({ type: "event", turnId, event }),
      onSetup: (setup) => ctx.postMessage({ type: "setup", turnId, setup }),
    });
    session.updatedAt = Date.now();
    ctx.postMessage({
      type: "done",
      turnId,
      result: { ...result, shellSnapshot: await captureShellState(session.bash) },
    });
  } catch (error) {
    ctx.postMessage({
      type: "failed",
      turnId,
      error: error instanceof Error ? error.message : String(error),
      aborted: error instanceof Error && error.name === "AbortError",
      messages: error instanceof AgentTurnError ? error.messages : null,
    });
  } finally {
    turnControllers.delete(turnId);
  }
}

ctx.onmessage = (event) => {
  const message = event.data;
  if (message.type === "run") {
    void runTurn(message.turnId, message.request);
  } else if (message.type === "abort") {
    turnControllers.get(message.turnId)?.abort();
  } else {
    const call = hostCalls.get(message.callId);
    if (!call) throw new Error(`Unknown host call ${message.callId}`);
    hostCalls.delete(message.callId);
    if (message.ok) call.resolve(message.value);
    else call.reject(new Error(message.error));
  }
};
