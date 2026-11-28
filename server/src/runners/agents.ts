import { randomUUID } from "node:crypto";
import type { ScreenInputEvent } from "#agent/nodes/protocol.ts";
import { nodeRegistry, type ScreenViewer } from "#agent/nodes/registry.ts";
import type { Platform } from "#platform/platform.ts";
import type { PromptResult } from "./contract.ts";
import { agentRunners, callbackOrigin, type Runner, startRun } from "./runners.ts";

/**
 * Agent sessions on runners: chats whose agent runs on a node or an HTTP
 * runner that offers agents. Each prompt is an `agent` run; its `updates`
 * calls stream the agent's ACP session updates, and its `result` call ends the
 * turn. The session lives here, between turns, until it is closed
 * (`agent.close`).
 */

/** How long a finished session stays readable. */
const FINISHED_RETENTION_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 200_000;
/** How long a chat's session may sit between prompts before it is closed. */
const CHAT_IDLE_MS = 30 * 60_000;
/** A turn's inactivity deadline, renewed by every call its runner makes. */
const TURN_TIMEOUT_MS = 15 * 60_000;

/** `idle` is a chat's session between prompts. */
export type AgentSessionStatus = "running" | "idle" | "done" | "failed" | "cancelled";

type Turn = {
  onUpdate(update: Record<string, unknown>): void;
  onScreen(sessionId: string): void;
};

type AgentSession = {
  id: string;
  spaceId: string;
  /** Whose runners it runs on, and who may open its screen. */
  userId: string;
  runner: Runner;
  agent: string;
  /** What the agent's Vektor tools act with. */
  jobToken: string;
  status: AgentSessionStatus;
  output: string;
  error?: string;
  screen: boolean;
  /** The chat's key in {@link chats}; null for a session not tied to one. */
  chat: string | null;
  /** The bot this session speaks for: its channel id, shared by its threads. */
  environmentId: string | null;
  /** A chat's prompt in flight. */
  turn?: Turn;
  cancelTurn?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const sessions = new Map<string, AgentSession>();
/** A chat's session, by chat key. */
const chats = new Map<string, string>();

type ChatScope = { spaceId: string; chatId: string };

const chatKey = (scope: ChatScope) => `${scope.spaceId}\0${scope.chatId}`;

const isOpen = (session: AgentSession) =>
  session.status === "running" || session.status === "idle";

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
});

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
  chat: { key: string; environmentId?: string } | null,
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
        ? `No runner or node "${request.runner}" is available.`
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
    screen: false,
    chat: chat?.key ?? null,
    environmentId: chat?.environmentId ?? null,
  };
  sessions.set(session.id, session);
  if (chat) chats.set(chat.key, session.id);
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
      environmentId: session.environmentId ?? undefined,
      agent: session.agent,
      prompt: text,
      mcp: {
        url: `${callbackOrigin()}/api/mcp`,
        headers: {
          "X-Space-Id": session.spaceId,
          "X-Job-Token": session.jobToken,
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
  // Its prompt then resolves as cancelled.
  session.cancelTurn?.();
  session.turn = undefined;
  void session.runner
    .send({ kind: "agent.close", sessionId: session.id })
    .catch(() => {});
  session.runner.screens?.closeAll(session.id);
  setTimeout(() => sessions.delete(session.id), FINISHED_RETENTION_MS).unref?.();
}

/** A chat's prompt ended; its session waits for the next unless the agent failed. */
function endTurn(session: AgentSession, result: PromptResult) {
  if (!isOpen(session)) return;
  if (result.stopReason === "error") {
    settle(session, "failed", result.error ?? "The agent failed.");
    return;
  }
  session.turn = undefined;
  session.status = "idle";
  session.idleTimer = setTimeout(
    () => settle(session, "cancelled", "Closed after being idle."),
    CHAT_IDLE_MS,
  );
  session.idleTimer.unref?.();
}

function chatSession(scope: ChatScope) {
  return sessions.get(chats.get(chatKey(scope)) ?? "");
}

/**
 * Starts one prompt of a chat on its session at `runner`, opening one with the
 * chat's pinned `agent` when it has none: on its first prompt, after an idle
 * timeout, or after the agent failed. A fresh session remembers nothing, so it
 * is sent `preamble` ahead of the prompt.
 */
export async function promptChat(
  platform: Platform,
  request: ChatScope & {
    /** The owner, whose runners the chat may use. */
    userId: string;
    /** The bot's channel id, shared by the channel and all its threads; managed bots leave it unset. */
    environmentId?: string;
    runner: string;
    agent: string;
    jobToken: string;
    text: string;
    preamble: string;
  } & Turn,
): Promise<{ fresh: boolean; result: Promise<PromptResult> }> {
  const existing = chatSession(request);
  const session =
    existing ??
    (await open(platform, request, {
      key: chatKey(request),
      environmentId: request.environmentId,
    }));
  if (session.status !== "idle")
    throw new Error("A prompt is already running in this chat.");
  session.turn = { onUpdate: request.onUpdate, onScreen: request.onScreen };
  if (session.screen) request.onScreen(session.id);
  const text =
    existing || !request.preamble
      ? request.text
      : `${request.preamble}\n\n## New messages\n${request.text}`;
  const result = prompt(session, text);
  void result.then((ended) => endTurn(session, ended));
  return { fresh: !existing, result };
}

/** Stops a chat's prompt in flight; its session stays open. */
export function cancelChat(scope: ChatScope) {
  const session = chatSession(scope);
  if (session?.status === "running") session.cancelTurn?.();
}

/** Ends a chat's session, if it has one. */
export function closeChat(scope: ChatScope) {
  const session = chatSession(scope);
  if (session) settle(session, "cancelled", "The chat was closed.");
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
