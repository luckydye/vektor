import { eq } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { preference } from "./schema/space.ts";

/**
 * The agent web-search endpoint is stored as an ordinary space preference:
 * the full host+path the `websearch` tool hits with a `q` query parameter
 * (e.g. a self-hosted SearXNG `https://searx.example.com/search?format=json`).
 * It is read/written through the standard space preferences API, so this key
 * must stay in sync with the one the settings UI writes.
 */
export const AGENT_SEARCH_URL_KEY = "agent:searchUrl";

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
