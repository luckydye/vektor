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

/** Exa's hosted MCP server: free and keyless, rate-limited per client IP. */
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

type JsonRpcResponse = {
  result?: { content: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { code: number; message: string };
};

export async function webSearch(args: Record<string, unknown>): Promise<string> {
  const { query, numResults = 5 } = args as { query: unknown; numResults?: number };
  if (typeof query !== "string" || !query.trim()) {
    throw new Error('web_search "query" must be a non-empty string.');
  }
  if (!Number.isInteger(numResults) || numResults < 1 || numResults > 10) {
    throw new Error('web_search "numResults" must be an integer from 1 to 10.');
  }

  const response = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query, numResults } },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Exa ${response.status} ${response.statusText}: ${body}`);
  }

  // Streamable HTTP may answer as a single SSE event instead of plain JSON.
  const json = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5))
        .join("")
    : body;
  const { result, error } = JSON.parse(json) as JsonRpcResponse;
  if (error) throw new Error(`Exa ${error.code}: ${error.message}`);
  if (!result) throw new Error(`Exa returned no result: ${body}`);

  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) throw new Error(`Exa: ${text}`);
  return text;
}
