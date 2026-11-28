import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";
import { AclKind, botPrincipal, ResourceType } from "#acl/permissions.ts";
import { logAclChange } from "#acl/store.ts";
import type { ChatImage, ChatImageAttachment } from "#api/provider/types.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import {
  acl,
  type ChatMessageRow,
  type ChatSessionRow,
  chatMessage,
  chatSession,
  workflowSchedule,
} from "#db/schema/space.ts";
import { mentionsToText } from "#utils/markdown.ts";

export type ChatSessionSource = ChatSessionRow["source"];
export type ChatVisibility = ChatSessionRow["visibility"];
export type ChatAccess = ChatSessionRow["access"];

export type StoredChatSession = Omit<ChatSessionRow, "createdAt" | "updatedAt"> & {
  spaceId: string;
  createdAt: number;
  updatedAt: number;
};

/** A file a user attached to their message, as the UI shows it. */
export type ChatAttachment = {
  key: string;
  url: string;
  name: string;
  type: string;
  size: number;
  isImage: boolean;
};

/** What a row carries besides its role and content. */
export type ChatMessageMetadata = {
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  thinking?: string | null;
  /** Images a tool produced, inline; uploads go in `imageAttachments`. */
  images?: ChatImage[];
  imageAttachments?: ChatImageAttachment[];
  /** On a tool row: the tool that produced it. */
  toolName?: string;
  attachments?: ChatAttachment[];
  /** A failed, cancelled or interrupted round's closing row. */
  isError?: boolean;
  /** The document the poster had open. */
  documentId?: string;
  /** The poster's IANA time zone. */
  timeZone?: string;
  /** On an event row: where it came from, who posted it, and its payload. */
  event?: { source: string; sentBy: string; data?: unknown };
  /** Read by the next round, but starts none and needs no answer of its own. */
  quiet?: boolean;
};

/**
 * Rows a round must answer: posted by someone, and not quiet. Kept beside
 * {@link isAnsweredRow} so the SQL and the in-memory rule cannot drift apart.
 */
const answerableRow = () =>
  and(
    eq(chatMessage.role, "user"),
    sql`${chatMessage.authorId} IS NOT NULL`,
    sql`coalesce(json_extract(${chatMessage.metadata}, '$.quiet'), 0) = 0`,
  );

/** Whether a round must answer `row`; see {@link answerableRow}. */
export function isAnsweredRow(row: StoredChatMessage): boolean {
  return row.role === "user" && !!row.authorId && !row.metadata.quiet;
}

export type StoredChatMessage = {
  seq: number;
  sessionId: string;
  role: ChatMessageRow["role"];
  authorId: string | null;
  content: string;
  visible: boolean;
  metadata: ChatMessageMetadata;
  createdAt: number;
};

export type NewChatMessage = {
  role: ChatMessageRow["role"];
  authorId?: string | null;
  content: string;
  visible?: boolean;
  metadata?: ChatMessageMetadata;
};

/** A session as clients list it; never its shell or memory. */
export type ChatSessionSummary = {
  id: string;
  title: string;
  spaceId: string;
  source: ChatSessionSource;
  visibility: ChatVisibility;
  access: ChatAccess;
  rolePrompt: string | null;
  avatar: string | null;
  node: string | null;
  nodeAgent: string | null;
  createdBy: string;
  parentSessionId: string | null;
  threadRootSeq: number | null;
  createdAt: number;
  updatedAt: number;
};

function toStoredChatSession(s: SpaceStore, row: ChatSessionRow): StoredChatSession {
  return {
    ...row,
    spaceId: s.spaceId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toChatSessionSummary(session: StoredChatSession): ChatSessionSummary {
  return {
    id: session.id,
    // Titles are flattened on read too: ones saved before creation-time flattening still hold raw mentions.
    title: mentionsToText(session.title),
    spaceId: session.spaceId,
    source: session.source,
    visibility: session.visibility,
    access: session.access,
    rolePrompt: session.rolePrompt,
    avatar: session.avatar,
    node: session.node,
    nodeAgent: session.nodeAgent,
    createdBy: session.createdBy,
    parentSessionId: session.parentSessionId,
    threadRootSeq: session.threadRootSeq,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toStoredChatMessage(row: ChatMessageRow): StoredChatMessage {
  return {
    seq: row.seq,
    sessionId: row.sessionId,
    role: row.role,
    authorId: row.authorId,
    content: row.content,
    visible: row.visible,
    metadata: JSON.parse(row.metadata) as ChatMessageMetadata,
    createdAt: row.createdAt.getTime(),
  };
}

export async function getChatSession(
  s: SpaceStore,
  sessionId: string,
): Promise<StoredChatSession | null> {
  const [row] = await s.db.select().from(chatSession).where(eq(chatSession.id, sessionId));
  return row ? toStoredChatSession(s, row) : null;
}

/** Bot channels, newest activity first, with how many threads each has. */
export async function listChannels(
  s: SpaceStore,
): Promise<Array<StoredChatSession & { threadCount: number }>> {
  const threads = s.db
    .select({ parentId: chatSession.parentSessionId, threadCount: count().as("thread_count") })
    .from(chatSession)
    .groupBy(chatSession.parentSessionId)
    .as("threads");
  const rows = await s.db
    .select({ session: chatSession, threadCount: threads.threadCount })
    .from(chatSession)
    .leftJoin(threads, eq(threads.parentId, chatSession.id))
    .where(and(eq(chatSession.visibility, "space"), isNull(chatSession.parentSessionId)))
    .orderBy(asc(chatSession.title));
  return rows.map((row) => ({
    ...toStoredChatSession(s, row.session),
    threadCount: row.threadCount ?? 0,
  }));
}

/** A channel's threads, with how many visible messages each holds. */
export async function listThreads(
  s: SpaceStore,
  parentSessionId: string,
): Promise<Array<StoredChatSession & { messageCount: number }>> {
  const counts = s.db
    .select({
      sessionId: chatMessage.sessionId,
      messageCount: count().as("message_count"),
    })
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.visible, true),
        sql`(${chatMessage.role} = 'user' OR (${chatMessage.role} = 'assistant' AND ${chatMessage.content} != ''))`,
      ),
    )
    .groupBy(chatMessage.sessionId)
    .as("counts");
  const rows = await s.db
    .select({ session: chatSession, messageCount: counts.messageCount })
    .from(chatSession)
    .leftJoin(counts, eq(counts.sessionId, chatSession.id))
    .where(eq(chatSession.parentSessionId, parentSessionId))
    .orderBy(desc(chatSession.updatedAt));
  return rows.map((row) => ({
    ...toStoredChatSession(s, row.session),
    messageCount: row.messageCount ?? 0,
  }));
}

/** Open an empty session; the server picks its id. A channel gets its bot's grant on the space. */
export async function createChatSession(
  s: SpaceStore,
  session: {
    title: string;
    createdBy: string;
    source: ChatSessionSource;
    visibility: ChatVisibility;
    access: ChatAccess;
    rolePrompt: string | null;
    avatar: string | null;
    node: string | null;
    nodeAgent: string | null;
    parentSessionId: string | null;
    threadRootSeq: number | null;
  },
): Promise<StoredChatSession> {
  return await s.tx(async (tx) => {
    const now = new Date();
    const [created] = await tx.db
      .insert(chatSession)
      .values({ id: createId("chatSession"), ...session, createdAt: now, updatedAt: now })
      .returning();
    if (!created) throw new Error("Failed to create chat session");

    if (session.visibility === "space" && !session.parentSessionId) {
      await tx.db.insert(acl).values({
        resourceType: ResourceType.SPACE,
        resourceId: tx.spaceId,
        userId: botPrincipal(created.id),
        groupId: null,
        permission: session.access,
        createdAt: now,
        updatedAt: now,
        name: session.title,
        kind: AclKind.BOT,
      });
      await logAclChange(tx, tx.spaceId, {
        event: "acl_grant",
        kind: AclKind.BOT,
        resourceType: ResourceType.SPACE,
        resourceId: tx.spaceId,
        userId: botPrincipal(created.id),
        permission: session.access,
        actorUserId: session.createdBy,
      });
    }
    return toStoredChatSession(tx, created);
  });
}

/** Edit a bot: its persona, and the access its grant carries. */
export async function updateChannel(
  s: SpaceStore,
  channelId: string,
  patch: {
    title?: string;
    rolePrompt?: string | null;
    avatar?: string | null;
    access?: ChatAccess;
  },
  actorUserId: string,
): Promise<void> {
  await s.tx(async (tx) => {
    await tx.db
      .update(chatSession)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(chatSession.id, channelId));
    const grant = and(
      eq(acl.userId, botPrincipal(channelId)),
      eq(acl.kind, AclKind.BOT),
    );
    if (patch.title !== undefined) {
      await tx.db.update(acl).set({ name: patch.title }).where(grant);
    }
    if (patch.access !== undefined) {
      const [previous] = await tx.db.select().from(acl).where(grant);
      if (!previous) throw new Error(`Bot ${channelId} has no grant`);
      if (previous.permission === patch.access) return;
      await tx.db
        .update(acl)
        .set({ permission: patch.access, updatedAt: new Date() })
        .where(grant);
      await logAclChange(tx, tx.spaceId, {
        event: "acl_grant",
        kind: AclKind.BOT,
        resourceType: ResourceType.SPACE,
        resourceId: tx.spaceId,
        userId: botPrincipal(channelId),
        permission: patch.access,
        previousPermission: previous.permission,
        actorUserId,
      });
    }
  });
}

/** Delete a session with its messages; a channel takes its threads and its bot's grant with it. */
export async function deleteChatSession(
  s: SpaceStore,
  sessionId: string,
  actorUserId: string,
): Promise<string[]> {
  return await s.tx(async (tx) => {
    const threads = await tx.db
      .select({ id: chatSession.id })
      .from(chatSession)
      .where(eq(chatSession.parentSessionId, sessionId));
    const ids = [sessionId, ...threads.map((thread) => thread.id)];
    await tx.db.delete(chatMessage).where(inArray(chatMessage.sessionId, ids));
    await tx.db.delete(chatSession).where(inArray(chatSession.id, ids));
    // Schedules posting here, and the bot's own, would only fail from now on.
    await tx.db
      .delete(workflowSchedule)
      .where(
        or(
          inArray(workflowSchedule.sessionId, ids),
          eq(workflowSchedule.createdBy, botPrincipal(sessionId)),
        ),
      );
    const removed = await tx.db
      .delete(acl)
      .where(and(eq(acl.userId, botPrincipal(sessionId)), eq(acl.kind, AclKind.BOT)))
      .returning();
    for (const grant of removed) {
      await logAclChange(tx, tx.spaceId, {
        event: "acl_revoke",
        kind: AclKind.BOT,
        resourceType: ResourceType.SPACE,
        resourceId: tx.spaceId,
        userId: grant.userId ?? undefined,
        previousPermission: grant.permission,
        actorUserId,
      });
    }
    return ids;
  });
}

/** Append rows to a session's log, in order; returns their seqs. */
export async function appendChatMessages(
  s: SpaceStore,
  sessionId: string,
  messages: NewChatMessage[],
): Promise<number[]> {
  if (messages.length === 0) return [];
  return await s.tx(async (tx) => {
    const now = new Date();
    // First, so a session deleted meanwhile takes no orphan rows.
    const [touched] = await tx.db
      .update(chatSession)
      .set({ updatedAt: now })
      .where(eq(chatSession.id, sessionId))
      .returning({ id: chatSession.id });
    if (!touched) throw new Error(`Chat session ${sessionId} was deleted`);
    const seqs: number[] = [];
    // One insert per row: a multi-row insert does not promise its ids in order.
    for (const message of messages) {
      const [row] = await tx.db
        .insert(chatMessage)
        .values({
          sessionId,
          role: message.role,
          authorId: message.authorId ?? null,
          content: message.content,
          visible: message.visible ?? true,
          metadata: JSON.stringify(message.metadata ?? {}),
          createdAt: now,
        })
        .returning({ seq: chatMessage.seq });
      if (!row) throw new Error("Failed to append a chat message");
      seqs.push(row.seq);
    }
    return seqs;
  });
}

/** One page of a session's visible rows, oldest first, ending before `beforeSeq`. */
export async function listVisibleChatMessages(
  s: SpaceStore,
  sessionId: string,
  page: { beforeSeq?: number; limit: number },
): Promise<StoredChatMessage[]> {
  const rows = await s.db
    .select()
    .from(chatMessage)
    .where(
      and(
        eq(chatMessage.sessionId, sessionId),
        eq(chatMessage.visible, true),
        page.beforeSeq === undefined ? undefined : lt(chatMessage.seq, page.beforeSeq),
      ),
    )
    .orderBy(desc(chatMessage.seq))
    .limit(page.limit);
  return rows.reverse().map(toStoredChatMessage);
}

/** Every row after `afterSeq`, oldest first: what the model reads past the memory. */
export async function listChatMessagesAfter(
  s: SpaceStore,
  sessionId: string,
  afterSeq: number,
): Promise<StoredChatMessage[]> {
  const rows = await s.db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.sessionId, sessionId), gt(chatMessage.seq, afterSeq)))
    .orderBy(asc(chatMessage.seq));
  return rows.map(toStoredChatMessage);
}

export async function getChatMessage(
  s: SpaceStore,
  sessionId: string,
  seq: number,
): Promise<StoredChatMessage | null> {
  const [row] = await s.db
    .select()
    .from(chatMessage)
    .where(and(eq(chatMessage.sessionId, sessionId), eq(chatMessage.seq, seq)));
  return row ? toStoredChatMessage(row) : null;
}

/** The newest row a round must answer, or 0 when there is none. */
export async function lastUserSeq(s: SpaceStore, sessionId: string): Promise<number> {
  const [row] = await s.db
    .select({ seq: max(chatMessage.seq) })
    .from(chatMessage)
    .where(and(eq(chatMessage.sessionId, sessionId), answerableRow()));
  return row?.seq ?? 0;
}

export async function updateChatSessionState(
  s: SpaceStore,
  sessionId: string,
  state: Partial<
    Pick<
      ChatSessionRow,
      "repliedThroughSeq" | "memory" | "memoryThroughSeq" | "shellSnapshot"
    >
  >,
): Promise<void> {
  await s.db.update(chatSession).set(state).where(eq(chatSession.id, sessionId));
}

/**
 * Close every round a previous process left running. Rounds live in that
 * process's memory, so after a restart a user row past the watermark has no
 * agent behind it. Call before the server takes requests: past that point such
 * a row may have a live round.
 */
export async function failInterruptedChatTurns(s: SpaceStore): Promise<void> {
  const rows = await s.db
    .select({ id: chatSession.id, target: max(chatMessage.seq) })
    .from(chatSession)
    .innerJoin(chatMessage, eq(chatMessage.sessionId, chatSession.id))
    .where(and(answerableRow(), gt(chatMessage.seq, chatSession.repliedThroughSeq)))
    .groupBy(chatSession.id);

  for (const row of rows) {
    if (row.target === null) continue;
    await appendChatMessages(s, row.id, [
      {
        role: "assistant",
        content: "Sorry, this response was interrupted by a server restart.",
        metadata: { isError: true },
      },
    ]);
    await updateChatSessionState(s, row.id, { repliedThroughSeq: row.target });
  }
}
