/**
 * The one turn loop every chat session runs through, private or a bot's.
 *
 * Posting appends a user row and makes sure the session's loop is running. A
 * round answers every user row up to the newest it saw when it started (its
 * `target`); rows posted while it runs wait for the next round of the same
 * loop. A loop is owned by the server, not by any connection: a disconnect does
 * not stop it, and `session/load` re-attaches to the round in progress.
 */

import { resolveGranteeName } from "#acl/directory.ts";
import { canAccess } from "#acl/guards.ts";
import {
  botPrincipal,
  channelOfBotPrincipal,
  eventAuthor,
  Permission,
  ResourceType,
  sourceOfEventAuthor,
} from "#acl/permissions.ts";
import type { ChatImage, ChatMessage } from "#api/provider/types.ts";
import { getLocalOrigin } from "#config";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { reserveAITokens } from "#db/space/aiUsage.ts";
import {
  appendChatMessages,
  type ChatSessionSummary,
  getChatMessage,
  getChatSession,
  isAnsweredRow,
  lastUserSeq,
  listChatMessagesAfter,
  type NewChatMessage,
  type StoredChatMessage,
  type StoredChatSession,
  updateChatSessionState,
} from "#db/space/chatSessions.ts";
import { listOAuthIntegrationsForUser } from "#db/space/oauthIntegrations.ts";
import { getUserProfile } from "#db/space/userProfiles.ts";
import { resolveUserAIProvider } from "#integrations/aiProvider.ts";
import { createJobToken } from "#jobs/jobToken.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { runChatOnRunner } from "#runners/chat.ts";
import { type AgentEvent, runAgentInWorker } from "./agent.ts";
import { callModel } from "./model.ts";
import { scheduleProfileUpdate } from "./profileUpdater.ts";
import { AgentTurnError } from "./turnError.ts";

/**
 * One round of a session's loop. Finished rounds stay readable until the
 * loop is dropped, so a load just after a round ends still gets its result.
 */
export type ChatRound = {
  /** The newest user row this round answers. */
  target: number;
  /** All events emitted so far; replayed to late-joining clients. */
  events: AgentEvent[];
  /** Callbacks for clients subscribed to live events. */
  listeners: Set<(event: AgentEvent) => void>;
  /** Resolves once the round's rows are written. */
  promise: Promise<void>;
  done: boolean;
  error: string | null;
  abort: () => void;
};

type ChatLoop = {
  round: ChatRound | null;
  done: boolean;
  /** The newest user row a poster is waiting on. */
  wanted: number;
  waiters: Array<{
    seq: number;
    resolve: (round: ChatRound) => void;
    reject: (error: Error) => void;
  }>;
  /** A private session's rounds run with the token its latest post came with. */
  jobToken: string | null;
};

/** Keyed by `spaceId:sessionId`. */
const loops = new Map<string, ChatLoop>();

/** How long a finished loop stays readable for clients catching up. */
const LOOP_RETENTION_MS = 5 * 60_000;

/** How much of the log past the memory the model reads before the oldest part is summarized. */
const MEMORY_BUDGET_CHARS = 120_000;

/** How many rows a fresh node session is told about. */
const PREAMBLE_ROWS = 12;

const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;

const loopKey = (spaceId: string, sessionId: string) => `${spaceId}:${sessionId}`;

export function chatRound(spaceId: string, sessionId: string): ChatRound | null {
  return loops.get(loopKey(spaceId, sessionId))?.round ?? null;
}

export function isChatRunning(spaceId: string, sessionId: string): boolean {
  const loop = loops.get(loopKey(spaceId, sessionId));
  return !!loop && !loop.done;
}

/** Stops the round in progress; its whole batch counts as answered. */
export function cancelChatRound(spaceId: string, sessionId: string): void {
  const round = chatRound(spaceId, sessionId);
  if (round && !round.done) round.abort();
}

function emitRoundEvent(round: ChatRound, event: AgentEvent) {
  round.events.push(event);
  for (const listener of round.listeners) listener(event);
}

/** A user row's own facts the model reads beside its text. */
export type ChatPost = {
  authorId: string;
  text: string;
  attachments: NonNullable<NewChatMessage["metadata"]>["attachments"];
  imageAttachments: NonNullable<NewChatMessage["metadata"]>["imageAttachments"];
  additionalContext?: string;
  documentId?: string;
  timeZone?: string;
  /** The posting bot's channel, when one bot messages another. */
  fromBot?: string;
};

/**
 * Appends a user row (and its additional context, as a row only the model
 * reads). `round` resolves once the round that answers it has started.
 */
export async function postChatMessage(
  platform: Platform,
  session: StoredChatSession,
  post: ChatPost,
  /** The poster's job token; a private session's rounds run with it. */
  jobToken: string,
): Promise<{ seq: number; round: Promise<ChatRound> }> {
  const store = await openSpaceStore(platform, session.spaceId);
  const [seq] = await appendChatMessages(store, session.id, [
    {
      role: "user",
      authorId: post.authorId,
      content: post.text,
      metadata: {
        ...(post.attachments?.length ? { attachments: post.attachments } : {}),
        ...(post.imageAttachments?.length
          ? { imageAttachments: post.imageAttachments }
          : {}),
        ...(post.documentId ? { documentId: post.documentId } : {}),
        ...(post.timeZone ? { timeZone: post.timeZone } : {}),
        ...(post.fromBot ? { fromBot: post.fromBot } : {}),
      },
    },
    ...(post.additionalContext
      ? [
          {
            role: "user" as const,
            content: `Additional context for the preceding message:\n${post.additionalContext}`,
            visible: false,
          },
        ]
      : []),
  ]);
  return { seq, round: waitForRound(platform, session, seq, jobToken) };
}

/** An event from an outside service, posted to a session. */
export type ChatEvent = {
  /** Names the service, e.g. `github`; see `EVENT_SOURCE_PATTERN`. */
  source: string;
  text: string;
  /** A JSON payload the model reads beside the text. */
  data?: unknown;
  /** Waits for the next round instead of starting one. */
  quiet: boolean;
  /** The principal that posted it, kept for the record. */
  sentBy: string;
};

/**
 * Appends an event row. A waking event starts a round like a post does, and is
 * batched with whatever else arrived; a quiet one is only read by the next.
 * Neither waits for the round: the service posting it is not listening.
 */
export async function postChatEvent(
  platform: Platform,
  session: StoredChatSession,
  event: ChatEvent,
  /** The poster's job token; a private session's rounds run with it. */
  jobToken: string,
): Promise<number> {
  const store = await openSpaceStore(platform, session.spaceId);
  const [seq] = await appendChatMessages(store, session.id, [
    {
      role: "user",
      authorId: eventAuthor(event.source),
      content: event.text,
      metadata: {
        event: {
          source: event.source,
          sentBy: event.sentBy,
          ...(event.data === undefined ? {} : { data: event.data }),
        },
        ...(event.quiet ? { quiet: true } : {}),
      },
    },
  ]);
  if (event.quiet) {
    announce(session, "posted");
  } else {
    waitForRound(platform, session, seq, jobToken).catch((error) => {
      appLogger.error("Chat event found no round", {
        spaceId: session.spaceId,
        sessionId: session.id,
        error,
      });
    });
  }
  return seq;
}

/**
 * Registers interest in the round that answers `seq`, starting the session's
 * loop when none runs. Nothing awaits between the check and the registration,
 * so a loop finishing concurrently either sees this waiter or is replaced.
 */
function waitForRound(
  platform: Platform,
  session: StoredChatSession,
  seq: number,
  jobToken: string,
): Promise<ChatRound> {
  const key = loopKey(session.spaceId, session.id);
  let loop = loops.get(key);
  if (!loop || loop.done) {
    loop = { round: null, done: false, wanted: 0, waiters: [], jobToken: null };
    loops.set(key, loop);
    void runLoop(platform, session.spaceId, session.id, loop);
  }
  loop.wanted = Math.max(loop.wanted, seq);
  if (session.visibility === "private") loop.jobToken = jobToken;
  // Already answered (or being answered) by this loop's latest round.
  const current = loop.round;
  if (current && current.target >= seq) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    loop.waiters.push({ seq, resolve, reject });
  });
}

function announce(session: StoredChatSession, state: "started" | "ended" | "posted") {
  if (session.visibility !== "space") return;
  sendSyncEvent(session.spaceId, {
    topic: realtimeTopics.chat,
    data: { sessionId: session.id, parentSessionId: session.parentSessionId, state },
  });
}

async function runLoop(
  platform: Platform,
  spaceId: string,
  sessionId: string,
  loop: ChatLoop,
): Promise<void> {
  const key = loopKey(spaceId, sessionId);
  try {
    for (;;) {
      const store = await openSpaceStore(platform, spaceId);
      const session = await getChatSession(store, sessionId);
      if (!session) throw new Error(`Chat session ${sessionId} was deleted`);
      const target = await lastUserSeq(store, sessionId);
      if (target <= session.repliedThroughSeq) {
        // A post that registered after the read above is answered by another pass.
        if (loop.wanted > session.repliedThroughSeq) continue;
        // Anyone still waiting posted a row an earlier round already answered.
        for (const waiter of loop.waiters) {
          if (loop.round) waiter.resolve(loop.round);
          else waiter.reject(new Error("The message was already answered"));
        }
        loop.waiters = [];
        break;
      }

      const controller = new AbortController();
      let finish = () => {};
      const round: ChatRound = {
        target,
        events: [],
        listeners: new Set(),
        promise: new Promise<void>((resolve) => {
          finish = resolve;
        }),
        done: false,
        error: null,
        abort: () => controller.abort(),
      };
      loop.round = round;
      loop.waiters = loop.waiters.filter((waiter) => {
        if (waiter.seq > target) return true;
        waiter.resolve(round);
        return false;
      });
      announce(session, "started");

      try {
        await runRound(platform, store, session, round, controller.signal, loop);
      } catch (error) {
        round.error ??= error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        round.done = true;
        finish();
        announce(session, "ended");
      }

      await compactMemory(platform, store, sessionId).catch((error) => {
        appLogger.error("Chat memory compaction failed", { spaceId, sessionId, error });
      });
    }
  } catch (error) {
    appLogger.error("Chat loop failed", { spaceId, sessionId, error });
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of loop.waiters) waiter.reject(failure);
    loop.waiters = [];
  } finally {
    loop.done = true;
    const timer = setTimeout(() => {
      if (loops.get(key) === loop) loops.delete(key);
    }, LOOP_RETENTION_MS);
    (timer as { unref?: () => void }).unref?.();
  }
}

/** Who a round runs as, and the persona it carries. */
type RoundContext = {
  /** The bot's channel; the session itself when it is a channel or private. */
  channel: StoredChatSession;
  /** The owner whose provider, nodes and (for a private session) profile it uses. */
  ownerId: string;
  /** The ACL principal the round's job token carries. */
  principal: string;
  jobToken: string;
  /** Null for a private session. */
  bot: { name: string; rolePrompt: string | null } | null;
  /** A thread's root row, from its channel. */
  root: StoredChatMessage | null;
};

async function roundContext(
  platform: Platform,
  store: SpaceStore,
  session: StoredChatSession,
  loop: ChatLoop,
): Promise<RoundContext> {
  if (session.visibility === "private") {
    if (!loop.jobToken) throw new Error("A private round needs its poster's job token");
    return {
      channel: session,
      ownerId: session.createdBy,
      principal: session.createdBy,
      jobToken: loop.jobToken,
      bot: null,
      root: null,
    };
  }

  const channel = session.parentSessionId
    ? await getChatSession(store, session.parentSessionId)
    : session;
  if (!channel) throw new Error(`Channel ${session.parentSessionId} was deleted`);
  const owner = channel.createdBy;
  if (
    !(await canAccess(
      platform,
      store.spaceId,
      { type: ResourceType.SPACE, id: store.spaceId },
      owner,
      Permission.EDITOR,
    ))
  ) {
    throw new Error("This bot's owner is no longer an editor of the space.");
  }
  const principal = botPrincipal(channel.id);
  const root =
    session.threadRootSeq === null
      ? null
      : await getChatMessage(store, channel.id, session.threadRootSeq);
  return {
    channel,
    ownerId: owner,
    principal,
    jobToken: createJobToken(store.spaceId, Date.now().toString(), principal, {
      app: "agent",
    }),
    bot: { name: channel.title, rolePrompt: channel.rolePrompt },
    root,
  };
}

/** Display names of who posted `rows`, by id; a bot is named by its channel. */
async function authorNames(
  store: SpaceStore,
  rows: StoredChatMessage[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.flatMap((row) => (row.authorId ? [row.authorId] : [])))];
  const names = await Promise.all(
    ids.map(async (id) => {
      const source = sourceOfEventAuthor(id);
      if (source) return [id, `${source} (event)`] as const;
      const channelId = channelOfBotPrincipal(id);
      if (channelId) {
        const channel = await getChatSession(store, channelId);
        return [id, channel?.title ?? id] as const;
      }
      return [id, (await resolveGranteeName(store.platform, id)) ?? id] as const;
    }),
  );
  return new Map(names);
}

/** How a bot's own scheduled posts are labelled for the model. */
const SCHEDULED_TASK = "a task it scheduled";

/**
 * How a row's author reads to the model. A bot's post is either a task it
 * scheduled for itself, or a message to another bot.
 */
function authorName(row: StoredChatMessage, names: Map<string, string>): string {
  const authorId = row.authorId ?? "";
  const name = names.get(authorId) ?? authorId;
  if (row.metadata.fromBot) return `${name} (bot)`;
  if (channelOfBotPrincipal(authorId)) return `${name} (${SCHEDULED_TASK})`;
  return name;
}

/** A row as the model reads it: a person's post is prefixed with their name. */
function toModelMessage(
  row: StoredChatMessage,
  names: Map<string, string>,
  facts: boolean,
): ChatMessage {
  const { tool_calls, tool_call_id, thinking, images, imageAttachments } = row.metadata;
  let content = row.content;
  if (row.authorId) {
    const name = authorName(row, names);
    content = `${name}: ${row.content}`;
    const data = row.metadata.event?.data;
    if (data !== undefined) content += `\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    // The batch being answered states where each poster is.
    const { documentId, timeZone } = row.metadata;
    if (facts && (documentId || timeZone)) {
      const notes = [
        documentId ? `${name} has document ${documentId} open` : "",
        timeZone ? `${name}'s time zone is ${timeZone}` : "",
      ].filter(Boolean);
      content += `\n\n(${notes.join("; ")}.)`;
    }
  }
  return {
    role: row.role,
    content,
    ...(tool_calls ? { tool_calls } : {}),
    ...(tool_call_id ? { tool_call_id } : {}),
    ...(thinking ? { thinking } : {}),
    ...(images ? { images } : {}),
    ...(imageAttachments ? { imageAttachments } : {}),
  };
}

function rowLine(row: StoredChatMessage, names: Map<string, string>): string {
  if (row.authorId) return `${authorName(row, names)}: ${row.content}`;
  if (row.role === "tool") {
    return `[${row.metadata.toolName ?? "tool"} result]: ${row.content.slice(0, 500)}`;
  }
  return `Assistant: ${row.content}`;
}

/** The sections a session adds after the core system prompt. */
async function sessionSections(
  store: SpaceStore,
  session: StoredChatSession,
  context: RoundContext,
  names: Map<string, string>,
): Promise<string> {
  const sections: string[] = [];
  if (context.bot) {
    sections.push(
      `## Bot Role\nYou are "${context.bot.name}", a bot in a channel shared by the people of this space. ` +
        "Each message from a person starts with their name; several people may be talking.\n" +
        `This conversation's session id is \`${session.id}\`. To act here later — a reminder, a recurring check — ` +
        "call `create_agent_trigger` with that `sessionId`; the prompt then arrives in this conversation " +
        `as a message from "${context.bot.name} (${SCHEDULED_TASK})", an instruction from your earlier self ` +
        "rather than from a person.\n" +
        'Messages from "<source> (event)" come from outside services, not people: act on them as your ' +
        "role says, and keep the answer short when an event needs nothing. " +
        'Messages from "<name> (bot)" come from another bot: use list_bots to find its channel, and ' +
        "send_bot_message to answer it; never loop back and forth without a person.\n" +
        "Your role below is written by the people who run you. When someone lastingly contradicts or refines it — " +
        "a changed opinion, a new audience, a different tone — call `propose_role_update` with the complete " +
        "revised text rather than silently drifting from it; an editor applies it. In the conversation itself, " +
        "do what the person asked right away.\n\n" +
        (context.bot.rolePrompt?.trim() || "You are a general assistant."),
    );
  }
  const memory: string[] = [];
  if (session.memory.trim()) memory.push(session.memory.trim());
  if (session.parentSessionId) {
    if (context.channel.memory.trim()) {
      memory.push(`### Channel memory\n${context.channel.memory.trim()}`);
    }
    if (context.root) {
      const rootNames = await authorNames(store, [context.root]);
      memory.push(
        `### This thread replies to\n${rowLine(context.root, new Map([...names, ...rootNames]))}`,
      );
    }
  }
  if (memory.length) sections.push(`## Bot Memory\n${memory.join("\n\n")}`);
  return sections.join("\n\n");
}

/** Loads persisted image references only for the outbound model request. */
async function hydrateMessageImages(
  platform: Platform,
  spaceId: string,
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  return await Promise.all(
    messages.map(async (message) => {
      if (message.images?.length || !message.imageAttachments?.length) return message;
      const images = await Promise.all(
        message.imageAttachments.map(async (attachment): Promise<ChatImage | null> => {
          const file = await platform.blobStore.read(spaceId, attachment.key);
          if (!file || file.byteLength > MAX_CHAT_IMAGE_BYTES) return null;
          return { mediaType: attachment.mediaType, data: file.toString("base64") };
        }),
      );
      return {
        ...message,
        images: images.filter((image): image is ChatImage => image !== null),
      };
    }),
  );
}

/**
 * A node turn's rows, rebuilt from its events in the order they streamed. A
 * tool call is kept only with its result, so the log never holds a dangling call.
 */
function rowsFromEvents(events: AgentEvent[]): NewChatMessage[] {
  const results = new Map(
    events.flatMap((event) =>
      event.type === "tool_result" ? [[event.toolCallId, event] as const] : [],
    ),
  );
  const rows: NewChatMessage[] = [];
  let text = "";
  const flush = () => {
    if (text.trim()) rows.push({ role: "assistant", content: text });
    text = "";
  };
  for (const event of events) {
    if (event.type === "text") text += event.text;
    if (event.type !== "tool_call") continue;
    const result = results.get(event.toolCallId);
    if (!result) continue;
    flush();
    rows.push({
      role: "assistant",
      content: "",
      metadata: {
        tool_calls: [
          {
            id: event.toolCallId,
            type: "function",
            function: { name: event.toolName, arguments: event.toolArguments },
          },
        ],
      },
    });
    rows.push({
      role: "tool",
      content: result.content,
      metadata: {
        tool_call_id: event.toolCallId,
        toolName: event.toolName,
        ...(result.isError ? { isError: true } : {}),
      },
    });
  }
  flush();
  return rows;
}

/** A server turn's model messages as rows, tool results labelled for the UI. */
function rowsFromMessages(messages: ChatMessage[], events: AgentEvent[]): NewChatMessage[] {
  const failed = new Set(
    events.flatMap((event) =>
      event.type === "tool_result" && event.isError ? [event.toolCallId] : [],
    ),
  );
  const toolNames = new Map(
    messages.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => [call.id, call.function.name] as const),
    ),
  );
  return messages.flatMap((message): NewChatMessage[] => {
    const { role, content, tool_calls, tool_call_id, thinking, images, imageAttachments } =
      message;
    if (role === "system") return [];
    return [
      {
        role,
        content: content ?? "",
        // A user message the turn wrote itself (its context, a tool's images) is the model's alone.
        visible: role !== "user",
        metadata: {
          ...(tool_calls ? { tool_calls } : {}),
          ...(tool_call_id
            ? {
                tool_call_id,
                toolName: toolNames.get(tool_call_id),
                ...(failed.has(tool_call_id) ? { isError: true } : {}),
              }
            : {}),
          ...(thinking ? { thinking } : {}),
          ...(images ? { images } : {}),
          ...(imageAttachments ? { imageAttachments } : {}),
        },
      },
    ];
  });
}

const partialText = (events: AgentEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

/** Runs one round and writes its rows; throws only when they cannot be written. */
async function runRound(
  platform: Platform,
  store: SpaceStore,
  session: StoredChatSession,
  round: ChatRound,
  signal: AbortSignal,
  loop: ChatLoop,
): Promise<void> {
  const { spaceId } = store;
  const rows = await listChatMessagesAfter(store, session.id, session.memoryThroughSeq);
  const batch = rows.filter(
    (row) => row.seq > session.repliedThroughSeq && row.seq <= round.target,
  );
  const latest = batch.filter(isAnsweredRow).at(-1) as StoredChatMessage;
  const names = await authorNames(store, rows);
  // Rows posted after the target wait for the next round.
  const history = rows.filter((row) => row.seq <= round.target);

  let written: NewChatMessage[];
  let shellSnapshot: string | null | undefined;
  try {
    const context = await roundContext(platform, store, session, loop);
    if (session.node) {
      if (!session.nodeAgent) throw new Error("This session has no agent on its node.");
      const preamble = [
        await sessionSections(store, session, context, names),
        history
          .filter((row) => row.seq <= session.repliedThroughSeq && row.visible)
          .slice(-PREAMBLE_ROWS)
          .map((row) => rowLine(row, names))
          .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n## Earlier messages\n");
      const result = await runChatOnRunner(platform, {
        spaceId,
        userId: context.ownerId,
        environmentId: context.channel.id,
        chatId: session.id,
        runner: session.node,
        agent: session.nodeAgent,
        jobToken: context.jobToken,
        text: batch
          .filter((row) => row.role === "user")
          .map((row) => toModelMessage(row, names, true).content)
          .join("\n\n"),
        preamble,
        signal,
        onEvent: (event) => emitRoundEvent(round, event),
      });
      written = rowsFromEvents(round.events);
      if (written.length === 0) written = [{ role: "assistant", content: result.content }];
    } else {
      const isPrivate = session.visibility === "private";
      const [userProfile, integrations, provider, sections] = await Promise.all([
        isPrivate ? getUserProfile(store, context.ownerId) : null,
        isPrivate ? listOAuthIntegrationsForUser(store, context.ownerId) : [],
        resolveUserAIProvider(platform, spaceId, context.ownerId),
        sessionSections(store, session, context, names),
      ]);
      const messages = await hydrateMessageImages(
        platform,
        spaceId,
        history.map((row) => toModelMessage(row, names, row.seq > session.repliedThroughSeq)),
      );
      const result = await runAgentInWorker(platform, {
        chatId: session.id,
        messages,
        userProfile: userProfile ?? undefined,
        sessionSections: sections || undefined,
        timeZone: latest.metadata.timeZone,
        connectedProviders: integrations.map((integration) => integration.provider),
        provider,
        userId: isPrivate ? context.ownerId : null,
        apiUrl: getLocalOrigin(),
        spaceId,
        documentId: latest.metadata.documentId,
        jobToken: context.jobToken,
        shellSnapshot: session.shellSnapshot,
        signal,
        onEvent: (event) => emitRoundEvent(round, event),
      });
      written = rowsFromMessages(result.messages, round.events);
      shellSnapshot = result.shellSnapshot ?? null;
    }
  } catch (error) {
    if (signal.aborted) {
      const text = partialText(round.events);
      written = [
        ...(text.trim() ? [{ role: "assistant" as const, content: text }] : []),
        { role: "assistant", content: "Response stopped.", metadata: { isError: true } },
      ];
    } else {
      appLogger.error("Chat round failed", { spaceId, sessionId: session.id, error });
      round.error = error instanceof Error ? error.message : "Agent request failed";
      written = [
        ...(error instanceof AgentTurnError
          ? rowsFromMessages(error.messages, round.events)
          : []),
        {
          role: "assistant",
          content: `Sorry, I encountered an error: ${round.error}`,
          metadata: { isError: true },
        },
      ];
    }
  }

  await appendChatMessages(store, session.id, written);
  await updateChatSessionState(store, session.id, {
    repliedThroughSeq: round.target,
    ...(shellSnapshot === undefined ? {} : { shellSnapshot }),
  });

  if (session.visibility === "private" && !session.node && !round.error) {
    scheduleProfileUpdate(platform, {
      spaceId,
      userId: session.createdBy,
      session: {
        id: session.id,
        title: session.title,
        messages: [...history, ...written].filter((row) => row.visible !== false),
      },
    });
  }
}

/**
 * Summarizes the oldest rows past the memory into it while the rest exceeds
 * the budget. A chunk ends just before a user row, so a tool call is never
 * split from its result. Runs between rounds, never beside one.
 */
async function compactMemory(
  platform: Platform,
  store: SpaceStore,
  sessionId: string,
): Promise<void> {
  const session = await getChatSession(store, sessionId);
  if (!session) return;
  let rows = await listChatMessagesAfter(store, sessionId, session.memoryThroughSeq);
  const size = (list: StoredChatMessage[]) =>
    list.reduce(
      (total, row) => total + row.content.length + (row.metadata.tool_calls ? 200 : 0),
      0,
    );
  let memory = session.memory;
  const channel = session.parentSessionId
    ? await getChatSession(store, session.parentSessionId)
    : session;
  if (!channel) return;

  while (size(rows) > MEMORY_BUDGET_CHARS) {
    // Never past a row still waiting for its answer: the next round reads it in full.
    const unanswered = rows.findIndex(
      (row) => isAnsweredRow(row) && row.seq > session.repliedThroughSeq,
    );
    const limit = unanswered === -1 ? rows.length : unanswered;
    let total = 0;
    let end = -1;
    for (const [index, row] of rows.entries()) {
      total += row.content.length;
      if (total < MEMORY_BUDGET_CHARS / 2) continue;
      const next = rows.findIndex((candidate, at) => at > index && isAnsweredRow(candidate));
      if (next !== -1 && next <= limit) end = next - 1;
      break;
    }
    if (end < 0) return;
    const chunk = rows.slice(0, end + 1);
    const names = await authorNames(store, chunk);
    const transcript = chunk
      .filter((row) => row.visible)
      .map((row) => rowLine(row, names))
      .join("\n\n");
    const { message } = await callModel({
      fetch: platform.fetch,
      spaceId: store.spaceId,
      provider: await resolveUserAIProvider(platform, store.spaceId, channel.createdBy),
      sessionId,
      messages: [
        {
          role: "user",
          content:
            "You keep the memory of a chat assistant: the facts, decisions, open tasks and preferences " +
            "from its conversation that it needs later. Merge the earlier part of the conversation below " +
            "into the memory. Keep who said what where it matters. Max 600 words. " +
            "Return only the updated memory as markdown.\n\n" +
            `## Current memory\n${memory || "(empty)"}\n\n## Conversation\n${transcript}`,
        },
      ],
      tools: [],
      reserveAITokens: (inputTokens) => reserveAITokens(store, inputTokens),
    });
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) throw new Error("The model returned an empty memory");
    memory = content;
    await updateChatSessionState(store, sessionId, {
      memory,
      memoryThroughSeq: (chunk.at(-1) as StoredChatMessage).seq,
    });
    rows = rows.slice(end + 1);
  }
}

/** A session as clients list it, with whether a round is running. */
export function withRunning<T extends ChatSessionSummary>(
  session: T,
): T & { running: boolean } {
  return { ...session, running: isChatRunning(session.spaceId, session.id) };
}
