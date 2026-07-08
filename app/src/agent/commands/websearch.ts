import { getAgentSearchUrl } from "#db/searchConfig.ts";

export type SearchResult = { title: string; url: string; snippet: string };

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Normalize a search API's JSON response into a common result shape so a
 * single tool works against any backend. The default schema is the SearXNG
 * style — `results[]` with `title` / `url` / `content` — and each field
 * falls back to the alternates other engines use when the default is absent
 * (Brave's `description`, Google's `snippet` / `link`, a bare array, etc.).
 */
export function extractSearchResults(data: unknown): SearchResult[] {
  if (Array.isArray(data)) return normalizeEntries(data);
  if (!data || typeof data !== "object") return [];
  const record = data as Record<string, unknown>;

  // Prefer `results[]`, then fall back to the containers other APIs use.
  const web = record.web as Record<string, unknown> | undefined;
  const candidates = [record.results, record.items, web?.results, record.data];
  const rawResults = candidates.find((c) => toArray(c).length > 0);

  return normalizeEntries(toArray(rawResults));
}

function normalizeEntries(entries: unknown[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const url = firstString(item.url, item.link, item.href, item.id);
    const title = firstString(item.title, item.name, item.heading, url);
    const snippet = firstString(
      item.content,
      item.snippet,
      item.description,
      item.text,
      item.summary,
      item.abstract,
    );
    if (!url && !title && !snippet) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

export function formatSearchResults(
  query: string,
  results: SearchResult[],
  limit: number,
): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .slice(0, limit)
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title || "(untitled)"}`];
      if (result.url) lines.push(`   ${result.url}`);
      if (result.snippet) lines.push(`   ${result.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function resolveLimit(rawCount: unknown): number {
  const value =
    typeof rawCount === "number"
      ? rawCount
      : typeof rawCount === "string"
        ? Number.parseInt(rawCount, 10)
        : Number.NaN;
  if (Number.isFinite(value) && value > 0) return Math.min(Math.floor(value), MAX_LIMIT);
  return DEFAULT_LIMIT;
}

/**
 * Execute the `websearch` tool: query the space's configured search endpoint
 * and return ranked results as text. Throws on any failure so the agent loop
 * reports it as a tool error.
 *
 * The endpoint host+path is set by a space owner in settings, so it is
 * trusted operator configuration (like the Ollama base URL). Only the `q`
 * value is model-influenced, and `URL.searchParams.set` keeps it confined to
 * the query string, so a private/self-hosted instance can be reached directly
 * without the public-only SSRF guard used for arbitrary `curl` targets.
 */
export async function runWebSearchTool(
  spaceId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error('websearch requires a non-empty "query".');
  const limit = resolveLimit(args.count);

  const configured = await getAgentSearchUrl(spaceId);
  if (!configured) {
    throw new Error(
      "No search endpoint configured. Set one in Space Settings → Agent → Web Search.",
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new Error(`Configured search URL is invalid: ${configured}`);
  }
  endpoint.searchParams.set("q", query);

  let response: Response;
  try {
    response = await fetch(endpoint.toString(), {
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new Error(
      `Search request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(`Search endpoint returned HTTP ${response.status}.`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Search endpoint did not return JSON. Ensure the configured URL returns JSON (e.g. SearXNG needs format=json).",
    );
  }

  return formatSearchResults(query, extractSearchResults(data), limit);
}
