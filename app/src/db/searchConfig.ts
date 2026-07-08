import { eq } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { preference } from "./schema/space.ts";

/**
 * The agent web-search endpoint is stored as a single space preference: the
 * full host+path the `websearch` command hits with a `q` query parameter
 * (e.g. a self-hosted SearXNG `https://searx.example.com/search?format=json`).
 * It is not a secret, so it lives in `preference` rather than `spaceSecret`.
 */
const AGENT_SEARCH_URL_KEY = "agent:searchUrl";

export async function getAgentSearchUrl(spaceId: string): Promise<string | null> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select()
    .from(preference)
    .where(eq(preference.key, AGENT_SEARCH_URL_KEY))
    .limit(1)
    .get();
  const value = row?.value?.trim();
  return value ? value : null;
}

export async function setAgentSearchUrl(spaceId: string, url: string): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const existing = await db
    .select()
    .from(preference)
    .where(eq(preference.key, AGENT_SEARCH_URL_KEY))
    .limit(1)
    .get();
  if (existing) {
    await db
      .update(preference)
      .set({ value: url, updatedAt: now })
      .where(eq(preference.id, existing.id));
  } else {
    await db.insert(preference).values({
      id: createId("preference"),
      key: AGENT_SEARCH_URL_KEY,
      value: url,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function deleteAgentSearchUrl(spaceId: string): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db.delete(preference).where(eq(preference.key, AGENT_SEARCH_URL_KEY));
}

export type AgentSearchConfigMeta =
  | { configured: false }
  | { configured: true; url: string };

export async function getAgentSearchConfigMeta(
  spaceId: string,
): Promise<AgentSearchConfigMeta> {
  const url = await getAgentSearchUrl(spaceId);
  return url ? { configured: true, url } : { configured: false };
}
