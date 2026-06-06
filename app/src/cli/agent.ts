/**
 * `vektor agent` — an interactive terminal agent, like Claude Code, that runs
 * the same internal Vektor agent loop used by the chat UI. The model runs
 * in-process (provider from env: OLLAMA_BASE_URL / ANTHROPIC_API_KEY /
 * OPENROUTER_API_KEY) and its bash tools (`vektor`, `recipes`, …) act on a
 * running Vektor instance over HTTP using a minted job token.
 *
 * Usage:
 *   vektor agent [prompt words...] [--doc <slug|id>] [--space <id>] [--url <host>]
 *                [--token <job-token>] [--once] [--user <userId>]
 *
 * With a prompt: runs one turn and exits. Without: opens a REPL (multi-turn).
 * Connection resolves like the other CLI commands: WIKI_HOST / --url,
 * WIKI_SPACE_ID / --space, AUTH_SECRET (to mint the job token) / --token.
 */

import { createInterface } from "node:readline";
import type { ChatMessage, AgentEvent } from "../agent/core.ts";
import { runAgentPrompt, getAIProvider } from "../agent/core.ts";
import { createJobToken } from "../jobs/jobToken.ts";
import { resolveHost, resolveSpaceId } from "./resolve.ts";

const useColor = process.stdout.isTTY === true;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
};

type AgentCliOptions = {
  prompt?: string;
  doc?: string;
  space?: string;
  url?: string;
  token?: string;
  user?: string;
  once?: boolean;
};

/** Resolves a `--doc` value (id or slug) to a concrete document id. */
async function resolveDocumentId(
  host: string,
  spaceId: string,
  headers: Record<string, string>,
  docArg: string,
): Promise<string> {
  const res = await fetch(
    `${host}/api/v1/spaces/${spaceId}/documents/${encodeURIComponent(docArg)}`,
    { headers },
  );
  if (res.ok) {
    const data = (await res.json()) as { document?: { id?: string } };
    if (data.document?.id) return data.document.id;
  }

  // Fall back to matching by slug in the document list.
  const listRes = await fetch(`${host}/api/v1/spaces/${spaceId}/documents`, { headers });
  if (listRes.ok) {
    const data = (await listRes.json()) as {
      documents?: Array<{ id: string; slug?: string }>;
    };
    const match = (data.documents ?? []).find((d) => d.slug === docArg || d.id === docArg);
    if (match) return match.id;
  }

  throw new Error(`Could not resolve document '${docArg}' in space ${spaceId}`);
}

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text":
      process.stdout.write(event.text);
      break;
    case "thinking":
      process.stdout.write(c.dim(event.text));
      break;
    case "tool_call": {
      let display = event.toolArguments;
      try {
        const args = JSON.parse(event.toolArguments) as { command?: string };
        if (typeof args.command === "string") display = args.command;
      } catch {
        // keep raw arguments
      }
      process.stdout.write(`\n${c.cyan("⏺")} ${c.bold(event.toolName)} ${c.dim(display)}\n`);
      break;
    }
    case "tool_result": {
      const lines = event.content.split("\n");
      const shown = lines.slice(0, 12);
      const prefix = event.isError ? c.red("  ⎿ ") : c.dim("  ⎿ ");
      const body = shown
        .map((line) => prefix + (line.length > 200 ? `${line.slice(0, 200)}…` : line))
        .join("\n");
      process.stdout.write(`${body}\n`);
      if (lines.length > shown.length) {
        process.stdout.write(c.dim(`  ⎿ … ${lines.length - shown.length} more lines\n`));
      }
      break;
    }
  }
}

async function runTurn(
  messages: ChatMessage[],
  ctx: {
    apiUrl: string;
    spaceId: string;
    documentId?: string;
    jobToken: string;
  },
): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const result = await runAgentPrompt({
      messages,
      apiUrl: ctx.apiUrl,
      spaceId: ctx.spaceId,
      documentId: ctx.documentId,
      jobToken: ctx.jobToken,
      signal: controller.signal,
      onEvent: (event) => renderEvent(event),
    });
    messages.push({ role: "assistant", content: result.content });
    process.stdout.write("\n");
  } catch (error) {
    if (controller.signal.aborted) {
      process.stdout.write(c.dim("\n[interrupted]\n"));
    } else {
      process.stdout.write(c.red(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`));
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

export async function commandAgent(options: AgentCliOptions): Promise<void> {
  const host = (options.url ?? resolveHost()).replace(/\/$/, "");

  // Fail fast with a clear message if no model provider is configured.
  let providerLabel: string;
  try {
    const provider = getAIProvider();
    providerLabel = `${provider.provider} (${provider.model})`;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }

  const spaceId = options.space ?? (await resolveSpaceId(host, undefined));
  const userId = options.user ?? null;
  const jobToken = options.token ?? createJobToken(spaceId, Date.now().toString(), userId);
  const authHeaders = { "X-Job-Token": jobToken, "X-Space-Id": spaceId };

  let documentId: string | undefined;
  if (options.doc) {
    documentId = await resolveDocumentId(host, spaceId, authHeaders, options.doc);
  }

  const ctx = { apiUrl: host, spaceId, documentId, jobToken };
  const messages: ChatMessage[] = [];

  process.stdout.write(
    c.dim(
      `vektor agent · ${providerLabel} · ${host}\n` +
        `space ${spaceId}${documentId ? ` · doc ${documentId}` : ""}\n`,
    ),
  );

  // One-shot mode: a prompt was supplied on the command line.
  if (options.prompt) {
    messages.push({ role: "user", content: options.prompt });
    process.stdout.write(`\n${c.green("›")} ${options.prompt}\n`);
    await runTurn(messages, ctx);
    if (options.once || !process.stdin.isTTY) return;
  }

  if (!process.stdin.isTTY) {
    if (!options.prompt) throw new Error("No prompt given and stdin is not a TTY.");
    return;
  }

  // Interactive REPL.
  process.stdout.write(c.dim("\nType a message. Ctrl-C interrupts a turn, Ctrl-D or /exit quits.\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    new Promise<string | null>((resolve) => {
      rl.question(`\n${c.green("›")} `, (answer) => resolve(answer));
      rl.once("close", () => resolve(null));
    });

  while (true) {
    const line = await ask();
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") break;
    messages.push({ role: "user", content: text });
    await runTurn(messages, ctx);
  }
  rl.close();
  process.stdout.write(c.dim("\nbye\n"));
}
