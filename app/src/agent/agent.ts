import { Bash } from "just-bash";
import {
  type AgentShellBootstrap,
  createAgentShell,
  type AgentEvent,
  type AgentResult,
  type ChatMessage,
  runAgentPrompt,
} from "./core.ts";
import type { VektorMcpConfig } from "../utils/vektorMcp.ts";
import { gzipSync, gunzipSync } from "node:zlib";

export type { AgentResult, ChatMessage };
export type { AgentEvent };
export { runAgentPrompt } from "./core.ts";

type AgentSession = {
  bash: Bash;
  mcpConfigRef: { current: VektorMcpConfig };
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
  return JSON.parse(gunzipSync(Buffer.from(snapshot, "base64")).toString("utf-8")) as SerializedShellState;
}

async function restoreShellState(bash: Bash, state: SerializedShellState) {
  const sortedEntries = [...state.entries].sort((left, right) => left.path.localeCompare(right.path));
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
    await bash.fs.writeFile(entry.path, Buffer.from(entry.contentBase64, "base64"), "binary");
    await bash.fs.chmod(entry.path, entry.mode);
    await bash.fs.utimes(entry.path, new Date(entry.mtime), new Date(entry.mtime));
  }
}

function getOrCreateSession(options: {
  chatId: string;
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  shellSnapshot?: string | null;
}): Promise<AgentSession> {
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
    };
    existing.updatedAt = now;
    return Promise.resolve(existing);
  }

  const parsedShellState = options.shellSnapshot ? parseShellState(options.shellSnapshot) : null;
  const bootstrap = parsedShellState
    ? ({ cwd: parsedShellState.cwd, env: parsedShellState.env } satisfies AgentShellBootstrap)
    : undefined;
  const mcpConfigRef = {
    current: {
      apiUrl: options.apiUrl,
      spaceId: options.spaceId,
      jobToken: options.jobToken,
      documentId: options.documentId,
    } satisfies VektorMcpConfig,
  };
  const session = {
    bash: createAgentShell(mcpConfigRef, bootstrap),
    mcpConfigRef,
    updatedAt: now,
  };
  sessionStore.set(key, session);
  if (parsedShellState) {
    return restoreShellState(session.bash, parsedShellState).then(() => session);
  }
  return Promise.resolve(session);
}

export async function runAgentInWorker(options: {
  chatId: string;
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
  shellSnapshot?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentResult> {
  const session = await getOrCreateSession(options);
  const result = await runAgentPrompt({
    ...options,
    bash: session.bash,
  });
  session.updatedAt = Date.now();
  return {
    ...result,
    shellSnapshot: await captureShellState(session.bash),
  };
}
