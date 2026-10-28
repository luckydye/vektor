import { randomUUID } from "node:crypto";
import type { ScreenInputEvent } from "#agent/nodes/protocol.ts";
import { nodeRegistry, type ScreenViewer } from "#agent/nodes/registry.ts";
import type { Platform } from "#platform/platform.ts";
import type { PromptResult } from "./contract.ts";
import { agentRunners, callbackOrigin, type Runner, startRun } from "./runners.ts";

/**
 * Agent sessions on runners: sub-agents and chats whose agent runs on a node
 * or an HTTP runner that offers agents. Each prompt is an `agent` run; its
 * `updates` calls stream the agent's ACP session updates, and its `result`
 * call ends the turn. The session lives here, between turns, until it is
 * closed (`agent.close`).
 */

/** How long a finished session stays readable. */
const FINISHED_RETENTION_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_MAILBOX = 100;
/** How long a chat's session may sit between prompts before it is closed. */
const CHAT_IDLE_MS = 30 * 60_000;
/** A turn's inactivity deadline, renewed by every call its runner makes. */
const TURN_TIMEOUT_MS = 15 * 60_000;

/** `idle` is a chat's session between prompts. */
export type AgentSessionStatus = "running" | "idle" | "done" | "failed" | "cancelled";

/** What a poll of a sub-agent's session reports. */
export type AgentSessionPoll = {
  status: AgentSessionStatus;
  /** The agent's final answer once finished, or its error. */
  output?: string;
  /** Whether viewers can open the session's screen. */
  screen: boolean;
  /** Messages the agent sent since the last poll. */
  messages: Array<{ to: string; text: string }>;
};

/** A runner the user may run agents on, as agents and clients see it. */
export type AgentRunnerSummary = {
  name: string;
  agents: string[];
  /** Sessions open there now. */
  running: number;
  /** Null when it has no limit. */
  maxSessions: number | null;
};

/** The server-side operations a sub-agent hub needs to run agents on runners. */
export interface AgentRunnerHost {
  listRunners(request: {
    spaceId: string;
    userId: string;
  }): Promise<AgentRunnerSummary[]>;
  startSession(request: {
    spaceId: string;
    userId: string;
    jobToken: string;
    task: string;
    runner?: string;
    agent?: string;
  }): Promise<{ sessionId: string; runner: string }>;
  /** Resolves at once with anything pending, else when something happens or `waitMs` passes. */
  pollSession(sessionId: string, waitMs: number): Promise<AgentSessionPoll>;
  sendToSession(sessionId: string, from: string, text: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
}

type Turn = {
  onUpdate(update: Record<string, unknown>): void;
  onScreen(sessionId: string): void;
  done(result: PromptResult): void;
};

type AgentSession = {
  id: string;
  spaceId: string;
  userId: string;
  runner: Runner;
  agent: string;
  /** What the agent's Vektor tools act with. */
  jobToken: string;
  status: AgentSessionStatus;
  output: string;
  error?: string;
  /** For the agent: `read_messages` drains it. */
  inbox: Array<{ from: string; text: string }>;
  /** From the agent to others in the turn; the hub drains it by polling. */
  outbox: Array<{ to: string; text: string }>;
  wake: Set<() => void>;
  screen: boolean;
  /** The chat whose session this is, kept open between prompts; null for a sub-agent's one-answer session. */
  chat: string | null;
  /** A chat's prompt in flight. */
  turn?: Turn;
  cancelTurn?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, AgentSession>();
/** A chat's session, by chat key. */
const chats = new Map<string, string>();

const chatKey = (scope: { spaceId: string; userId: string; chatId: string }) =>
  `${scope.spaceId}\0${scope.userId}\0${scope.chatId}`;

const isOpen = (session: AgentSession) =>
  session.status === "running" || session.status === "idle";

function notify(session: AgentSession) {
  for (const wake of session.wake) wake();
}

function openOn(runner: Runner) {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.runner.key === runner.key && isOpen(session)) count++;
  }
  return count;
}

const hasRoom = (runner: Runner) =>
  runner.maxSessions === undefined || openOn(runner) < runner.maxSessions;

nodeRegistry.watchScreens((sessionId, runnerKey) => {
  const session = sessions.get(sessionId);
  if (!session || session.runner.key !== runnerKey || !isOpen(session)) return;
  session.screen = true;
  session.turn?.onScreen(session.id);
  notify(session);
});

export async function listAgentRunners(
  platform: Platform,
  scope: { spaceId: string; userId: string },
): Promise<AgentRunnerSummary[]> {
  return (await agentRunners(platform, scope)).map((runner) => ({
    name: runner.name,
    agents: runner.description.agents,
    running: openOn(runner),
    maxSessions: runner.maxSessions ?? null,
  }));
}

/** Opens a session on one of the user's runners; it is idle until prompted. */
async function open(
  platform: Platform,
  request: {
    spaceId: string;
    userId: string;
    jobToken: string;
    runner?: string;
    agent?: string;
  },
  chat: string | null,
) {
  const runners = await agentRunners(platform, request);
  const runner = request.runner
    ? runners.find((r) => r.name === request.runner)
    : runners.find(
        (r) =>
          hasRoom(r) && (!request.agent || r.description.agents.includes(request.agent)),
      );
  if (!runner) {
    throw new Error(
      request.runner
        ? `No runner or node "${request.runner}" is available. Use list_nodes to see what is.`
        : "No runner or node can run an agent for you. Start a node with `vektor agent serve`.",
    );
  }
  const agent = request.agent ?? runner.description.agents[0];
  if (!runner.description.agents.includes(agent)) {
    throw new Error(
      `"${runner.name}" has no "${agent}" agent; it offers ${runner.description.agents.join(", ")}.`,
    );
  }
  if (!hasRoom(runner)) {
    throw new Error(
      `"${runner.name}" is running its maximum of ${runner.maxSessions} sessions.`,
    );
  }
  const session: AgentSession = {
    id: `as-${randomUUID()}`,
    spaceId: request.spaceId,
    userId: request.userId,
    runner,
    agent,
    jobToken: request.jobToken,
    status: "idle",
    output: "",
    inbox: [],
    outbox: [],
    wake: new Set(),
    screen: false,
    chat,
  };
  sessions.set(session.id, session);
  if (chat) chats.set(chat, session.id);
  return session;
}

function onUpdate(session: AgentSession, update: Record<string, unknown>) {
  if (session.turn) {
    session.turn.onUpdate(update);
    return;
  }
  const content = update.content as { type?: string; text?: unknown } | undefined;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    content?.type === "text" &&
    typeof content.text === "string" &&
    session.output.length < MAX_OUTPUT_CHARS
  ) {
    session.output += content.text;
  }
}

/** Runs one prompt as an `agent` run; resolves with how the turn ended. */
async function prompt(session: AgentSession, text: string): Promise<PromptResult> {
  session.status = "running";
  clearTimeout(session.idleTimer);
  const run = startRun(session.runner, {
    timeoutMs: TURN_TIMEOUT_MS,
    request: (runId, host) => ({
      kind: "agent",
      runId,
      sessionId: session.id,
      agent: session.agent,
      prompt: text,
      mcp: {
        url: `${callbackOrigin()}/api/mcp`,
        headers: {
          "X-Space-Id": session.spaceId,
          "X-Job-Token": session.jobToken,
          "X-Agent-Session": session.id,
        },
      },
      host,
    }),
    handle(name, args) {
      if (name !== "updates")
        throw new Error(`"${name}" is not a call an agent turn makes`);
      for (const update of Array.isArray(args[0]) ? args[0] : []) {
        if (typeof update === "object" && update !== null) onUpdate(session, update);
      }
      return null;
    },
  });
  let cancelled = false;
  session.cancelTurn = () => {
    cancelled = true;
    run.cancel();
  };
  try {
    const { stopReason, error } = (await run.result) as Partial<PromptResult>;
    if (stopReason === "end_turn" || stopReason === "cancelled") return { stopReason };
    return { stopReason: "error", error: String(error ?? "The agent failed.") };
  } catch (error) {
    if (cancelled) return { stopReason: "cancelled" };
    return {
      stopReason: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    session.cancelTurn = undefined;
  }
}

function settle(session: AgentSession, status: AgentSessionStatus, output: string) {
  if (!isOpen(session)) return;
  session.status = status;
  if (status === "done") session.output = output;
  else session.error = output;
  clearTimeout(session.idleTimer);
  if (session.chat && chats.get(session.chat) === session.id) chats.delete(session.chat);
  session.cancelTurn?.();
  const turn = session.turn;
  session.turn = undefined;
  turn?.done({
    stopReason: status === "cancelled" ? "cancelled" : "error",
    error: output,
  });
  void session.runner
    .send({ kind: "agent.close", sessionId: session.id })
    .catch(() => {});
  session.runner.screens?.closeAll(session.id);
  notify(session);
  setTimeout(() => sessions.delete(session.id), FINISHED_RETENTION_MS).unref?.();
}

/** A chat's prompt ended; its session waits for the next unless the agent failed. */
function endTurn(session: AgentSession, result: PromptResult) {
  if (!isOpen(session)) return;
  if (result.stopReason === "error") {
    settle(session, "failed", result.error ?? "The agent failed.");
    return;
  }
  const turn = session.turn;
  session.turn = undefined;
  session.status = "idle";
  session.idleTimer = setTimeout(
    () => settle(session, "cancelled", "Closed after being idle."),
    CHAT_IDLE_MS,
  );
  session.idleTimer.unref?.();
  turn?.done(result);
}

function chatSession(scope: { spaceId: string; userId: string; chatId: string }) {
  return sessions.get(chats.get(chatKey(scope)) ?? "");
}

/**
 * Starts one prompt of a chat on its session at `runner`, opening one when the
 * chat has none: on its first prompt, or after the session ended. `fresh`
 * says a session was opened, so it remembers no earlier prompt.
 */
export async function promptChat(
  platform: Platform,
  request: {
    spaceId: string;
    userId: string;
    chatId: string;
    runner: string;
    jobToken: string;
    text: string;
  } & Omit<Turn, "done">,
): Promise<{ fresh: boolean; result: Promise<PromptResult> }> {
  const existing = chatSession(request);
  const session = existing ?? (await open(platform, request, chatKey(request)));
  if (session.status !== "idle")
    throw new Error("A prompt is already running in this chat.");
  const result = new Promise<PromptResult>((done) => {
    session.turn = { onUpdate: request.onUpdate, onScreen: request.onScreen, done };
  });
  if (session.screen) request.onScreen(session.id);
  void prompt(session, request.text).then((ended) => endTurn(session, ended));
  return { fresh: !existing, result };
}

/** Stops a chat's prompt in flight; its session stays open. */
export function cancelChat(scope: { spaceId: string; userId: string; chatId: string }) {
  const session = chatSession(scope);
  if (session?.status === "running") session.cancelTurn?.();
}

/** Ends a chat's session, if it has one. */
export function closeChat(scope: { spaceId: string; userId: string; chatId: string }) {
  const session = chatSession(scope);
  if (session) settle(session, "cancelled", "The chat was closed.");
}

function sessionOf(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`No agent session "${sessionId}".`);
  return session;
}

/** The sub-agent side, for the agent worker's hub. */
export function createAgentRunnerHost(platform: Platform): AgentRunnerHost {
  return {
    listRunners: (scope) => listAgentRunners(platform, scope),

    async startSession(request) {
      const session = await open(platform, request, null);
      void prompt(session, request.task).then((result) => {
        if (result.stopReason === "end_turn") settle(session, "done", session.output);
        else if (result.stopReason === "cancelled")
          settle(session, "cancelled", "Cancelled.");
        else settle(session, "failed", result.error ?? "The agent failed.");
      });
      return { sessionId: session.id, runner: session.runner.name };
    },

    async pollSession(sessionId, waitMs) {
      const session = sessionOf(sessionId);
      if (session.status === "running" && !session.outbox.length && waitMs > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            session.wake.delete(done);
            resolve();
          };
          const timer = setTimeout(done, waitMs);
          session.wake.add(done);
        });
      }
      return {
        status: session.status,
        screen: session.screen,
        ...(session.status === "running"
          ? {}
          : {
              output: session.status === "done" ? session.output : (session.error ?? ""),
            }),
        messages: session.outbox.splice(0),
      };
    },

    async sendToSession(sessionId, from, text) {
      const session = sessionOf(sessionId);
      if (session.status !== "running")
        throw new Error("The agent is no longer running.");
      if (session.inbox.length >= MAX_MAILBOX) session.inbox.shift();
      session.inbox.push({ from, text });
    },

    async cancelSession(sessionId) {
      const session = sessions.get(sessionId);
      if (session) settle(session, "cancelled", "Cancelled.");
    },
  };
}

/**
 * What the agent's MCP tools reach. Scoped to the session's own user and
 * space, so a job token for another session cannot read or write this one.
 */
export function agentMailbox(
  sessionId: string,
  scope: { spaceId: string; userId: string | null },
) {
  const session = sessions.get(sessionId);
  if (!session || session.spaceId !== scope.spaceId || session.userId !== scope.userId) {
    throw new Error(`No agent session "${sessionId}".`);
  }
  return {
    readMessages: () => session.inbox.splice(0),
    sendMessage: (to: string, text: string) => {
      if (session.chat)
        throw new Error("This agent runs a chat; there is no other agent.");
      if (session.status !== "running")
        throw new Error("This agent is no longer running.");
      if (session.outbox.length >= MAX_MAILBOX)
        throw new Error("Too many unread messages.");
      session.outbox.push({ to, text });
      notify(session);
    },
  };
}

/** Opens an open session's screen for its own user; only nodes have screens. */
export function openAgentScreen(
  scope: { spaceId: string; userId: string; sessionId: string },
  viewer: ScreenViewer,
): { input(events: ScreenInputEvent[]): void; close(error?: string): void } {
  const session = sessions.get(scope.sessionId);
  if (
    !session ||
    session.spaceId !== scope.spaceId ||
    session.userId !== scope.userId ||
    !isOpen(session) ||
    !session.screen ||
    !session.runner.screens
  ) {
    throw new Error(`No screen for agent session "${scope.sessionId}".`);
  }
  return session.runner.screens.open(session.id, viewer);
}
