/**
 * Workflow command — runs a workflow document via the host API and streams logs.
 *
 * Connection settings come from `vektor login` (see resolve.ts), overridable
 * with VEKTOR_HOST, VEKTOR_SPACE_ID and VEKTOR_ACCESS_TOKEN.
 *
 * Usage:
 *   vektor workflow run <docId> [--input key=value ...] [--file key=/path ...] [--json]
 *
 * Examples:
 *   vektor workflow abc123 --input file=https://example.com/data.xlsx
 *   vektor workflow abc123 --file file=/path/to/data.xlsx --input title=MyRun
 *   vektor workflow abc123 --json
 */

import { apiFetch, apiJson, resolveConfig } from "./request.ts";

type RunResponse = {
  status: string;
  error: string | null;
  logs: string[];
  resultArtifact: { key: string; url: string } | null;
};

export type CliOptions = {
  documentId: string;
  inputs: Record<string, unknown>;
  filePaths: Record<string, string>;
  json: boolean;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function usage(): string {
  return [
    "Usage: vektor workflow run <docId> [--input key=value ...] [--json]",
    "",
    "Connection: vektor login, or VEKTOR_HOST / VEKTOR_SPACE_ID / VEKTOR_ACCESS_TOKEN",
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
  assert(
    !documentId.startsWith("--"),
    `Expected a document ID, got: ${documentId}\n\n${usage()}`,
  );

  const inputs: Record<string, unknown> = {};
  const filePaths: Record<string, string> = {};
  let json = false;

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
    if (arg === "--file") {
      const pair = argv[i + 1];
      assert(pair, "--file requires a key=/path argument");
      const eq = pair.indexOf("=");
      assert(eq > 0, `--file value must be key=/path, got: ${pair}`);
      filePaths[pair.slice(0, eq)] = pair.slice(eq + 1);
      i++;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  return {
    documentId,
    inputs,
    filePaths,
    json,
  };
}

function apiUrl(host: string, path: string): string {
  return `${host.replace(/\/$/, "")}${path}`;
}

async function uploadFile(
  url: string,
  spaceId: string,
  filePath: string,
): Promise<string> {
  const file = Bun.file(filePath);
  const name = filePath.split("/").pop() ?? "upload";
  const query = new URLSearchParams({ filename: name });
  const res = await apiFetch(apiUrl(url, `/api/v1/spaces/${spaceId}/uploads?${query}`), {
    method: "POST",
    headers: {
      Origin: new URL(url).origin,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`File upload failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { url: string };
  return data.url;
}

export async function commandLogs(runId: string): Promise<void> {
  const { host, spaceId } = await resolveConfig();

  const run = (await apiJson(
    apiUrl(host, `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`),
  )) as RunResponse;

  for (const line of run.logs) {
    process.stdout.write(`${line}\n`);
  }
}

export async function runWorkflow(options: CliOptions): Promise<RunResponse> {
  const { documentId, inputs, filePaths, json } = options;
  const { host, spaceId } = await resolveConfig();

  for (const [key, filePath] of Object.entries(filePaths)) {
    if (!json) process.stderr.write(`Uploading ${filePath}…\n`);
    inputs[key] = await uploadFile(host, spaceId, filePath);
    if (!json) process.stderr.write(`Uploaded: ${inputs[key]}\n`);
  }

  const { runId } = (await apiJson(
    apiUrl(host, `/api/v1/spaces/${spaceId}/workflows/runs`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        inputs: Object.keys(inputs).length > 0 ? inputs : undefined,
      }),
    },
  )) as { runId: string };

  if (!json) process.stderr.write(`Run started: ${runId}\n`);

  let logCursor = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, 2000));

    const run = (await apiJson(
      apiUrl(host, `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`),
    )) as RunResponse;

    if (!json) {
      const newLogs = run.logs.slice(logCursor);
      for (const line of newLogs) {
        process.stderr.write(`${line}\n`);
      }
      logCursor += newLogs.length;
    }

    if (run.status !== "running" && run.status !== "pending") {
      return run;
    }
  }
}
