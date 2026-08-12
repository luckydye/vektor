import { and, desc, eq, sql } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { aiChatSession } from "#db/schema/space.ts";

export type StoredAIChatSession = {
  id: string;
  title: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
  conversationHistory: unknown[];
  shellSnapshot: string | null;
};

/**
 * A session as the picker lists it: what a row renders, and nothing else.
 *
 * The transcript is the bulk of a session and only the resumed one needs it —
 * a space with a long chat history otherwise ships megabytes of messages to
 * draw a list of titles.
 */
export type AIChatSessionSummary = {
  id: string;
  title: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  /** Role of the last turn: "user" means the session is awaiting a reply. */
  lastMessageRole: string | null;
};

export type AIChatSessionInput = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
  conversationHistory: unknown[];
  shellSnapshot?: string | null;
};

function parseJsonArray(value: string, field: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid AI chat session ${field}`);
  }
  return parsed;
}

function toStoredAIChatSession(
  s: SpaceStore,
  row: typeof aiChatSession.$inferSelect,
): StoredAIChatSession {
  return {
    id: row.id,
    title: row.title,
    spaceId: s.spaceId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    messages: parseJsonArray(row.messages, "messages"),
    conversationHistory: parseJsonArray(row.conversationHistory, "conversationHistory"),
    shellSnapshot: row.shellSnapshot ?? null,
  };
}

export async function listAIChatSessionSummaries(
  s: SpaceStore,
  userId: string,
): Promise<AIChatSessionSummary[]> {
  const rows = await s.db
    .select({
      id: aiChatSession.id,
      title: aiChatSession.title,
      createdAt: aiChatSession.createdAt,
      updatedAt: aiChatSession.updatedAt,
      // The status dot needs the last turn's role, not the turns. SQLite reads
      // it out of the stored JSON so the column never leaves the database.
      lastMessageRole: sql<
        string | null
      >`json_extract(${aiChatSession.conversationHistory}, '$[#-1].role')`,
    })
    .from(aiChatSession)
    .where(eq(aiChatSession.createdBy, userId))
    .orderBy(desc(aiChatSession.updatedAt));

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    spaceId: s.spaceId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastMessageRole: row.lastMessageRole ?? null,
  }));
}

export async function getAIChatSession(
  s: SpaceStore,
  sessionId: string,
  userId: string,
): Promise<StoredAIChatSession | null> {
  const [row] = await s.db
    .select()
    .from(aiChatSession)
    .where(and(eq(aiChatSession.id, sessionId), eq(aiChatSession.createdBy, userId)));

  return row ? toStoredAIChatSession(s, row) : null;
}

export async function upsertAIChatSession(
  s: SpaceStore,
  userId: string,
  session: AIChatSessionInput,
): Promise<StoredAIChatSession> {
  const existing = await getAIChatSession(s, session.id, userId);
  const values = {
    id: session.id,
    title: session.title,
    createdBy: userId,
    createdAt: existing ? new Date(existing.createdAt) : new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    messages: JSON.stringify(session.messages),
    conversationHistory: JSON.stringify(session.conversationHistory),
    shellSnapshot:
      session.shellSnapshot === undefined
        ? (existing?.shellSnapshot ?? null)
        : session.shellSnapshot,
  };

  if (existing) {
    const [updated] = await s.db
      .update(aiChatSession)
      .set(values)
      .where(and(eq(aiChatSession.id, session.id), eq(aiChatSession.createdBy, userId)))
      .returning();
    if (!updated) {
      throw new Error("Failed to update AI chat session");
    }
    return toStoredAIChatSession(s, updated);
  }

  const [created] = await s.db.insert(aiChatSession).values(values).returning();
  if (!created) {
    throw new Error("Failed to create AI chat session");
  }
  return toStoredAIChatSession(s, created);
}

export async function deleteAIChatSession(
  s: SpaceStore,
  sessionId: string,
  userId: string,
): Promise<void> {
  await s.db
    .delete(aiChatSession)
    .where(and(eq(aiChatSession.id, sessionId), eq(aiChatSession.createdBy, userId)));
}
