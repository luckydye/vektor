/**
 * `vektor agent` — terminal chat UI backed by the server's ACP endpoint.
 * Inference and tool execution run server-side; the CLI streams and renders events.
 */

import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../agent/core.ts";
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

export type AgentCliOptions = {
  prompt?: string;
  doc?: string;
  user?: string;
  once?: boolean;
};

async function resolveDocument(
  host: string,
  spaceId: string,
  headers: Record<string, string>,
  docArg: string,
): Promise<{ id: string; type: string | null }> {
  const res = await fetch(
    `${host}/api/v1/spaces/${spaceId}/documents/${encodeURIComponent(docArg)}`,
    { headers },
  );
  if (res.ok) {
    const data = (await res.json()) as {
      document?: { id?: string; type?: string | null };
    };
    if (data.document?.id) {
      return { id: data.document.id, type: data.document.type ?? null };
    }
  }

  const listRes = await fetch(`${host}/api/v1/spaces/${spaceId}/documents`, { headers });
  if (listRes.ok) {
    const data = (await listRes.json()) as {
      documents?: Array<{ id: string; slug?: string; type?: string | null }>;
    };
    const match = (data.documents ?? []).find(
      (d) => d.slug === docArg || d.id === docArg,
    );
    if (match) return { id: match.id, type: match.type ?? null };
  }

  throw new Error(`Could not resolve document '${docArg}' in space ${spaceId}`);
}

function renderUpdate(update: Record<string, unknown>): void {
  const kind = update.sessionUpdate as string;

  if (kind === "agent_message_chunk") {
    const content = update.content as { type: string; text: string } | undefined;
    if (content?.type === "text") process.stdout.write(content.text);
  } else if (kind === "generic") {
    const generic = update.generic as { type: string; text: string } | undefined;
    if (generic?.type === "thinking") process.stdout.write(c.dim(generic.text));
  } else if (kind === "tool_call") {
    const title = update.title as string;
    const input = update.input as Record<string, unknown> | undefined;
    let display = input ? JSON.stringify(input) : "";
    if (typeof input?.command === "string") display = input.command;
    else if (typeof input?.code === "string") display = input.code;
    process.stdout.write(`\n${c.cyan("⏺")} ${c.bold(title)} ${c.dim(display)}\n`);
  } else if (kind === "tool_call_update") {
    const status = update.status as string;
    if (status === "completed" || status === "failed") {
      const contentList = update.content as
        | Array<{ type: string; content: { type: string; text: string } }>
        | undefined;
      const text = contentList?.[0]?.content?.text ?? "";
      const lines = text.split("\n");
      const shown = lines.slice(0, 12);
      const prefix = status === "failed" ? c.red("  ⎿ ") : c.dim("  ⎿ ");
      process.stdout.write(
        shown
          .map((line) => prefix + (line.length > 200 ? `${line.slice(0, 200)}…` : line))
          .join("\n") + "\n",
      );
      if (lines.length > shown.length) {
        process.stdout.write(c.dim(`  ⎿ … ${lines.length - shown.length} more lines\n`));
      }
    }
  }
}

async function runTurn(
  host: string,
  spaceId: string,
  sessionId: string,
  jobToken: string,
  history: ChatMessage[],
  userText: string,
  documentId: string | undefined,
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  const res = await fetch(`${host}/api/v1/chat/acp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Job-Token": jobToken,
      "X-Space-Id": spaceId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "session/prompt",
      params: {
        sessionId,
        spaceId,
        ...(documentId ? { documentId } : {}),
        messages: history,
        prompt: [{ type: "text", text: userText }],
      },
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error(`ACP request failed (${res.status}): ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulatedText = "";
  let finalError: string | undefined;

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6);
        if (raw === "[DONE]") break outer;

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (msg.method === "session/update") {
          const params = msg.params as { update?: Record<string, unknown> } | undefined;
          const update = params?.update;
          if (update) {
            if (
              update.sessionUpdate === "agent_message_chunk" &&
              (update.content as { text?: string } | undefined)?.text
            ) {
              accumulatedText += (update.content as { text: string }).text;
            }
            renderUpdate(update);
          }
        } else if ("error" in msg) {
          finalError = (msg.error as { message?: string })?.message ?? "Agent request failed";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finalError) throw new Error(finalError);

  return [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: accumulatedText },
  ];
}

export async function commandAgent(options: AgentCliOptions): Promise<void> {
  const host = resolveHost().replace(/\/$/, "");
  const spaceId = await resolveSpaceId(host, undefined);
  const userId = options.user ?? null;
  const jobToken = createJobToken(spaceId, Date.now().toString(), userId);
  const authHeaders = { "X-Job-Token": jobToken, "X-Space-Id": spaceId };
  const sessionId = randomUUID();

  let documentId: string | undefined;
  if (options.doc) {
    const resolved = await resolveDocument(host, spaceId, authHeaders, options.doc);
    documentId = resolved.id;
  }

  let history: ChatMessage[] = [];

  process.stdout.write(
    c.dim(
      `vektor agent · ${host} · space ${spaceId}${documentId ? ` · doc ${documentId}` : ""}\n`,
    ),
  );

  async function doTurn(userText: string): Promise<void> {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once("SIGINT", onInterrupt);
    try {
      history = await runTurn(
        host,
        spaceId,
        sessionId,
        jobToken,
        history,
        userText,
        documentId,
        controller.signal,
      );
      process.stdout.write("\n");
    } catch (error) {
      if (controller.signal.aborted) {
        process.stdout.write(c.dim("\n[interrupted]\n"));
      } else {
        process.stdout.write(
          c.red(`\n[error] ${error instanceof Error ? error.message : String(error)}\n`),
        );
      }
    } finally {
      process.removeListener("SIGINT", onInterrupt);
    }
  }

  if (options.prompt) {
    process.stdout.write(`\n${c.green("›")} ${options.prompt}\n`);
    await doTurn(options.prompt);
    if (options.once || !process.stdin.isTTY) return;
  }

  if (!process.stdin.isTTY) {
    if (!options.prompt) throw new Error("No prompt given and stdin is not a TTY.");
    return;
  }

  process.stdout.write(
    c.dim("\nType a message. Ctrl-C interrupts a turn, Ctrl-D or /exit quits.\n"),
  );
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
    await doTurn(text);
  }
  rl.close();
  process.stdout.write(c.dim("\nbye\n"));
}
