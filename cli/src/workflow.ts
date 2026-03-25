/**
 * Workflow command — runs a workflow document via the host API and streams logs.
 *
 * Required env vars (or flags):
 *   WIKI_HOST         e.g. http://localhost:3000   (or --url)
 *   WIKI_SPACE_ID     space identifier             (or --space)
 *   WIKI_ACCESS_TOKEN API token                    (or --token, optional for public spaces)
 *
 * Usage:
 *   vektor workflow <docId> [--input key=value ...] [--json] [--url <url>] [--space <id>] [--token <tok>]
 *
 * Examples:
 *   vektor workflow abc123 --input file=https://example.com/data.xlsx
 *   vektor workflow abc123 --json
 */

type NodeState = {
  status: string;
  logs: string[];
  outputs: Record<string, unknown> | null;
  error: string | null;
};

type RunResponse = {
  status: string;
  nodes: Record<string, NodeState>;
  output: Record<string, unknown> | null;
};

export type CliOptions = {
  documentId: string;
  inputs: Record<string, unknown>;
  json: boolean;
  url: string;
  spaceId: string;
  token: string | undefined;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function usage(): string {
  return [
    "Usage: vektor workflow <docId> [--input key=value ...] [--json] [--url <url>] [--space <id>] [--token <tok>]",
    "",
    "Options read from env if flags are omitted: WIKI_HOST, WIKI_SPACE_ID, WIKI_ACCESS_TOKEN",
    "",
    "Examples:",
    "  vektor workflow abc123",
    "  vektor workflow abc123 --input file=https://example.com/data.xlsx --input title=MyRun",
    "  vektor workflow abc123 --json",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  assert(argv.length > 0, usage());
  const documentId = argv[0];
  assert(!documentId.startsWith("--"), `Expected a document ID, got: ${documentId}\n\n${usage()}`);

  const inputs: Record<string, unknown> = {};
  let json = false;
  let urlFlag: string | undefined;
  let spaceFlag: string | undefined;
  let tokenFlag: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--input") {
      const pair = argv[i + 1];
      assert(pair, "--input requires a key=value argument");
      const eq = pair.indexOf("=");
      assert(eq > 0, `--input value must be key=value, got: ${pair}`);
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
      i++;
      continue;
    }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--url") { urlFlag = argv[++i]; assert(urlFlag, "--url requires a value"); continue; }
    if (arg === "--space") { spaceFlag = argv[++i]; assert(spaceFlag, "--space requires a value"); continue; }
    if (arg === "--token") { tokenFlag = argv[++i]; assert(tokenFlag, "--token requires a value"); continue; }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  const url = urlFlag ?? process.env.WIKI_HOST;
  const spaceId = spaceFlag ?? process.env.WIKI_SPACE_ID;
  assert(url, "--url is required (or set WIKI_HOST)");
  assert(spaceId, "--space is required (or set WIKI_SPACE_ID)");

  return { documentId, inputs, json, url, spaceId, token: tokenFlag ?? process.env.WIKI_ACCESS_TOKEN };
}

async function apiFetch(url: string, token: string | undefined, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function runWorkflow(options: CliOptions): Promise<RunResponse> {
  const { url, spaceId, token, documentId, inputs, json } = options;

  const { runId } = (await apiFetch(url, token, `/api/v1/spaces/${spaceId}/workflows/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId, inputs: Object.keys(inputs).length > 0 ? inputs : undefined }),
  })) as { runId: string };

  if (!json) process.stderr.write(`Run started: ${runId}\n`);

  const logCursors: Record<string, number> = {};

  while (true) {
    await new Promise((r) => setTimeout(r, 2000));

    const run = (await apiFetch(url, token, `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`)) as RunResponse;

    if (!json) {
      for (const [nodeId, node] of Object.entries(run.nodes)) {
        const cursor = logCursors[nodeId] ?? 0;
        const newLogs = node.logs.slice(cursor);
        for (const line of newLogs) {
          process.stderr.write(`[${nodeId}] ${line}\n`);
        }
        logCursors[nodeId] = cursor + newLogs.length;
      }
    }

    if (run.status !== "running" && run.status !== "pending") {
      return run;
    }
  }
}
