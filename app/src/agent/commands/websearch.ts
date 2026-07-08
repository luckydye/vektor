import { defineCommand } from "just-bash";
import { getAgentSearchUrl } from "#db/searchConfig.ts";
import type { VektorMcpConfig } from "#utils/vektorMcp.ts";

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
 * single command works against any backend. The default schema is the
 * SearXNG style — `results[]` with `title` / `url` / `content` — and each
 * field falls back to the alternates other engines use when the default is
 * absent (Brave's `description`, Google's `snippet` / `link`, a bare array,
 * etc.).
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

/**
 * `websearch [-n count] <query>` — query the space's configured search
 * endpoint and print ranked results.
 *
 * The endpoint host+path is set by a space owner in settings, so it is
 * trusted operator configuration (like the Ollama base URL). Only the `q`
 * value is model-influenced, and `URL.searchParams.set` keeps it confined to
 * the query string, so a private/self-hosted instance can be reached directly
 * without the public-only SSRF guard used for arbitrary `curl` targets.
 */
export function websearchCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("websearch", async (args, _ctx) => {
    let limit = DEFAULT_LIMIT;
    const terms: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-n" || arg === "--num") {
        const parsed = Number.parseInt(args[++i] ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
        continue;
      }
      terms.push(arg);
    }

    const query = terms.join(" ").trim();
    if (!query) {
      return { stdout: "", stderr: "usage: websearch [-n count] <query>\n", exitCode: 2 };
    }

    const configured = await getAgentSearchUrl(mcpConfigRef.current.spaceId);
    if (!configured) {
      return {
        stdout: "",
        stderr:
          "websearch: no search endpoint configured. Set one in Space Settings → Agent → Web Search.\n",
        exitCode: 1,
      };
    }

    let endpoint: URL;
    try {
      endpoint = new URL(configured);
    } catch {
      return {
        stdout: "",
        stderr: `websearch: configured search URL is invalid: ${configured}\n`,
        exitCode: 1,
      };
    }
    endpoint.searchParams.set("q", query);

    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      return {
        stdout: "",
        stderr: `websearch: request failed: ${error instanceof Error ? error.message : String(error)}\n`,
        exitCode: 1,
      };
    }

    if (!response.ok) {
      return {
        stdout: "",
        stderr: `websearch: HTTP ${response.status} from search endpoint\n`,
        exitCode: 22,
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        stdout: "",
        stderr:
          "websearch: endpoint did not return JSON. Ensure the configured URL returns JSON (e.g. SearXNG needs format=json).\n",
        exitCode: 1,
      };
    }

    const results = extractSearchResults(data);
    return {
      stdout: `${formatSearchResults(query, results, limit)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });
}
