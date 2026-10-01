import { config } from "#config";

export const webSearchTool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web with Exa. Returns the top results with title, url, published date and an excerpt of the page text. " +
      "Use it for current events or facts outside the space; fetch a full page with curl in bash when the excerpt is not enough.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        numResults: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          description: "Number of results (default 5, maximum 10).",
        },
      },
      required: ["query"],
    },
  },
};

/** Exa only runs when the operator configured a key; the free tier is enough. */
export function webSearchEnabled(): boolean {
  return Boolean(config().EXA_API_KEY?.trim());
}

export async function webSearch(args: Record<string, unknown>) {
  const apiKey = config().EXA_API_KEY?.trim();
  if (!apiKey) throw new Error("VEKTOR_EXA_API_KEY is not configured.");
  const { query, numResults = 5 } = args as { query: unknown; numResults?: number };
  if (typeof query !== "string" || !query.trim()) {
    throw new Error('web_search "query" must be a non-empty string.');
  }
  if (!Number.isInteger(numResults) || numResults < 1 || numResults > 10) {
    throw new Error('web_search "numResults" must be an integer from 1 to 10.');
  }

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      query,
      type: "auto",
      numResults,
      contents: { text: { maxCharacters: 1000 } },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Exa ${response.status} ${response.statusText}: ${await response.text()}`,
    );
  }
  const { results } = (await response.json()) as {
    results: Array<{
      title: string | null;
      url: string;
      publishedDate?: string;
      text?: string;
    }>;
  };
  return results.map(({ title, url, publishedDate, text }) => ({
    title,
    url,
    publishedDate,
    text,
  }));
}
