import { Bash } from "just-bash";
import {
  config,
  getConfiguredAnthropicModel,
  getConfiguredOllamaBaseUrl,
  getConfiguredOllamaModel,
  getConfiguredOpenRouterModel,
} from "../config.ts";
import type { VektorMcpConfig } from "../utils/vektorMcp.ts";
import { aiCommand } from "./commands/ai.ts";
import { curlCommand } from "./commands/curl.ts";
import { extensionCommand } from "./commands/extension.ts";
import { gitlabCommand } from "./commands/gitlab.ts";
import { jsExecCommand } from "./commands/jsExec.ts";
import { htmlTableToCsvCommand, htmlToCsvCommand } from "./commands/htmlToCsv.ts";
import { getRecipe, recipesCommand } from "./commands/recipes.ts";
import { runtimeStubCommands } from "./commands/runtimeStubs.ts";
import { uploadCommand } from "./commands/upload.ts";
import { vektorCommand } from "./commands/vektor.ts";
import { unzipCommand, zipCommand, zipinfoCommand } from "./commands/zip.ts";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  thinking?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export type AgentResult = {
  content: string;
  stopReason: string;
  shellSnapshot?: string | null;
};

export type AgentShellBootstrap = {
  cwd?: string;
  env?: Record<string, string>;
};

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "status"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      toolArguments: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
    };

function buildCoreAgentSystemPrompt(
  documentId?: string,
  connectedProviders?: string[],
  userProfile?: string,
  documentType?: string | null,
) {
  const gitlabConnected = !connectedProviders || connectedProviders.includes("gitlab");
  return `## Bash Tool Runtime
- js-exec runs JavaScript/TypeScript in a QuickJS sandbox: \`js-exec -c "..."\` or \`js-exec script.js\`. Has \`console\` and \`process\`; no \`require\`, \`fetch\`, or Node built-ins. NOTE: node, npm, python, and python3 are NOT installed — js-exec is the only scripting runtime. Don't write a script file and run it with node; use \`js-exec -c "..."\` directly.
- zip/unzip/zipinfo operate on the virtual filesystem (zip is always recursive). Use \`zipinfo\` instead of \`unzip -l\`.
- vektor CLI: \`vektor current\` (current doc), \`vektor read <id> [-n]\` (-n = line numbers), \`vektor list --json\`, \`vektor search "<q>" --json\`, \`vektor create --title "T" [--type type] [--parent id] [file]\`, \`vektor edit <id|current> <op>\` (partial edits — see \`recipes edit-text\`), \`vektor delete <id> [--permanent]\`. Pipe/redirect to/from virtual files as needed.
- upload <file> uploads from the virtual filesystem and returns JSON with a URL. Never share sandbox paths — always upload first.
- Only include final output files in zips; exclude intermediates.
- ai <prompt>: one-shot AI completion. curl: standard HTTP; pipe to \`html-to-markdown\` to convert HTML.${gitlabConnected ? "\n- gitlab sub-commands: `gitlab api <path>` raw API request via OAuth (paths relative to /api/v4, e.g. `gitlab api '/projects?search=name'`); `gitlab ls <project> [path] [--ref <ref>]` list repo directory; `gitlab cat <project> <file> [--ref <ref>]` file contents; `gitlab tree <project> [path] [--ref <ref>]` recursive listing. Use `gitlab api` to search/list projects — `ls/cat/tree` require an exact project ID or `namespace/project`." : ""}
- \`html-to-csv [file]\`: extract the first table from an HTML document as CSV. \`html-table-to-csv [file]\`: convert an HTML table fragment to CSV.
- \`extension install <zip-file>\`: install or update a Vektor extension from a ZIP file in the virtual filesystem.
- Prefer built-in shell utilities. On failure, inspect stderr and adapt — don't retry blindly.
- Loop over file lines with \`while read -r line; do ...; done < file.txt\` (\`<<\` is a heredoc, not a file).
- Don't use \`awk -F,\` for CSV column extraction — use \`grep -oE\` instead.

## Behavior
- Outline a short plan before starting. Verify each step before proceeding.
- Don't report results until verified. Don't restate visible tool output — only add interpretation, summaries, or next steps.
- Tool output is capped at ~6 000 chars — when truncated, see \`recipes large-output\`.
- Never install extensions unless the user explicitly asks.

## Recipes
- \`recipes\` lists step-by-step instructions for common tasks; \`recipes <name>\` prints one (e.g. \`recipes canvas\`, \`recipes create-doc\`); \`recipes search <words>\` finds by keyword.
- Before creating documents/apps, building extensions, or running workflows, run the matching recipe FIRST and follow it exactly.
- Quick map: edit-text, edit-json, canvas, create-doc, find-docs, app-doc, workflow, upload, extension, large-output.
${documentEditingSection(documentId, documentType)}${userProfile ? `\n\n## User Profile\n${userProfile}` : ""}`;
}

const READONLY_DOC_TYPES = new Set(["csv"]);

/** Maps a document type to the recipe that best explains how to edit it. */
function recipeForDocumentType(documentType?: string | null): string {
  if (documentType === "canvas") return "canvas";
  if (documentType === "app") return "app-doc";
  return "edit-text";
}

/**
 * When a document is in context, inline the editing playbook directly instead
 * of making the model discover it via \`recipes\`. Small models skip the lookup
 * step, so the most common task gets its instructions up front. The inlined
 * recipe is chosen by document type (canvas / app / html).
 */
function documentEditingSection(
  documentId?: string,
  documentType?: string | null,
): string {
  if (!documentId) return "";

  if (documentType && READONLY_DOC_TYPES.has(documentType)) {
    return `
## Current document
- The current document is read-only (type "${documentType}") and cannot be edited.
  If the user asks to change it, explain that it is read-only.`;
  }

  const isCanvas = documentType === "canvas";
  const recipeName = recipeForDocumentType(documentType);
  const recipe = getRecipe(recipeName);
  const readHint = isCanvas
    ? "`vektor current` (shapes/strokes as JSON)"
    : "`vektor current -n` (line-numbered)";

  return `
## Editing the current document
- "this document" / "the page" = the current document. Read it first with ${readHint}.
- To change it, ALWAYS use \`vektor edit current <op>\`. NEVER edit document content with
  sed, perl, python, js-exec, or by piping through grep/awk — those corrupt unicode (emoji,
  umlauts) and bypass collaborative editing. There is no temp-file step.
${
  recipe
    ? `- Playbook (\`recipes ${recipeName}\`):\n${recipe.body
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}`
    : ""
}`;
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;
      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") return;
          try {
            yield JSON.parse(payload) as Record<string, unknown>;
          } catch {
            // skip malformed
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseNDJSON(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        yield JSON.parse(trimmed) as Record<string, unknown>;
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail) as Record<string, unknown>;
    }
  } finally {
    reader.releaseLock();
  }
}

export type AIProvider =
  | {
      provider: "anthropic";
      apiKey: string;
      model: string;
    }
  | {
      provider: "openrouter";
      apiKey: string;
      model: string;
    }
  | {
      provider: "ollama";
      baseUrl: string;
      model: string;
    };

export function getAIProvider(): AIProvider {
  const cfg = config();
  if (cfg.OLLAMA_BASE_URL) {
    return {
      provider: "ollama",
      baseUrl: getConfiguredOllamaBaseUrl(),
      model: getConfiguredOllamaModel(),
    };
  }
  if (cfg.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      apiKey: cfg.ANTHROPIC_API_KEY,
      model: getConfiguredAnthropicModel(),
    };
  }
  if (cfg.OPENROUTER_API_KEY) {
    return {
      provider: "openrouter",
      apiKey: cfg.OPENROUTER_API_KEY,
      model: getConfiguredOpenRouterModel(),
    };
  }
  throw new Error(
    "No AI provider configured. Set OLLAMA_BASE_URL, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.",
  );
}

export function getOpenAICompatibleChatCompletionsUrl(
  _provider: Extract<AIProvider, { provider: "openrouter" }>,
): string {
  return "https://openrouter.ai/api/v1/chat/completions";
}

export function getOpenAICompatibleHeaders(
  provider: Extract<AIProvider, { provider: "openrouter" }>,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };
}

function toOllamaMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();

  return messages.map((message) => {
    if (message.role === "assistant") {
      const toolCalls = (message.tool_calls ?? []).map((toolCall, index) => {
        let parsedArguments: unknown;
        try {
          parsedArguments = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          parsedArguments = {};
        }

        toolNames.set(toolCall.id, toolCall.function.name);
        return {
          type: "function",
          function: {
            index,
            name: toolCall.function.name,
            arguments: parsedArguments,
          },
        };
      });

      const result: Record<string, unknown> = {
        role: "assistant",
      };
      if (message.content) result.content = message.content;
      if (message.thinking) result.thinking = message.thinking;
      if (toolCalls.length > 0) result.tool_calls = toolCalls;
      return result;
    }

    if (message.role === "tool") {
      if (!message.tool_call_id) {
        throw new Error("Ollama tool message is missing tool_call_id.");
      }
      const toolName = toolNames.get(message.tool_call_id);
      if (!toolName) {
        throw new Error(
          `Ollama tool message references unknown tool_call_id: ${message.tool_call_id}`,
        );
      }
      return {
        role: "tool",
        tool_name: toolName,
        content: message.content ?? "",
      };
    }

    return {
      role: message.role,
      content: message.content ?? "",
    };
  });
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }>;
} {
  const systemParts: string[] = [];
  const result: Array<{ role: "user" | "assistant"; content: string | unknown[] }> = [];

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      i++;
      continue;
    }

    if (msg.role === "tool") {
      const toolResults: unknown[] = [];
      while (i < messages.length && messages[i]!.role === "tool") {
        const m = messages[i]!;
        toolResults.push({
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content ?? "",
        });
        i++;
      }
      result.push({ role: "user", content: toolResults });
      continue;
    }

    if (msg.role === "assistant") {
      const content: unknown[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown;
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      result.push({
        role: "assistant",
        content:
          content.length === 1 && !msg.tool_calls?.length ? (msg.content ?? "") : content,
      });
      i++;
      continue;
    }

    result.push({ role: "user", content: msg.content ?? "" });
    i++;
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: result,
  };
}

type PartialToolCall = { id: string; name: string; arguments: string };

export async function callModel(options: {
  provider: AIProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  if (options.provider.provider === "anthropic") {
    const { system, messages: anthropicMessages } = toAnthropicMessages(options.messages);
    const anthropicTools = (
      options.tools as Array<{
        function: { name: string; description?: string; parameters: unknown };
      }>
    ).map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    const body: Record<string, unknown> = {
      model: options.provider.model,
      max_tokens: 8192,
      messages: anthropicMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (anthropicTools.length) body.tools = anthropicTools;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": options.provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
    }

    let textContent = "";
    let finishReason = "stop";
    const toolCalls: PartialToolCall[] = [];

    for await (const chunk of parseSSE(response.body)) {
      const type = (chunk as { type?: string }).type;

      if (type === "content_block_start") {
        const block = (
          chunk as { content_block?: { type: string; id?: string; name?: string } }
        ).content_block;
        if (block?.type === "tool_use") {
          toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: "" });
        }
      } else if (type === "content_block_delta") {
        const delta = (
          chunk as { delta?: { type?: string; text?: string; partial_json?: string } }
        ).delta;
        if (delta?.type === "text_delta" && delta.text) {
          textContent += delta.text;
          await options.onText?.(delta.text);
        } else if (
          delta?.type === "input_json_delta" &&
          delta.partial_json &&
          toolCalls.length > 0
        ) {
          toolCalls[toolCalls.length - 1]!.arguments += delta.partial_json;
        }
      } else if (type === "message_delta") {
        const stopReason = (chunk as { delta?: { stop_reason?: string } }).delta
          ?.stop_reason;
        if (stopReason === "tool_use") finishReason = "tool_calls";
        else if (stopReason) finishReason = stopReason;
      }
    }

    return {
      message: {
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      },
      finishReason,
    };
  }

  if (options.provider.provider === "ollama") {
    const response = await fetch(`${options.provider.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.provider.model,
        messages: toOllamaMessages(options.messages),
        tools: options.tools,
        stream: true,
        think: true,
      }),
      signal: options.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    }

    const pendingCalls = new Map<number, PartialToolCall>();
    let content = "";
    let thinking = "";
    let finishReason = "stop";

    for await (const chunk of parseNDJSON(response.body)) {
      const message = (chunk.message as Record<string, unknown> | undefined) ?? {};
      const thinkingDelta = typeof message.thinking === "string" ? message.thinking : "";
      const contentDelta = typeof message.content === "string" ? message.content : "";
      if (thinkingDelta) {
        thinking += thinkingDelta;
        await options.onThinking?.(thinkingDelta);
      }
      if (contentDelta) {
        content += contentDelta;
        await options.onText?.(contentDelta);
      }

      const toolCalls = Array.isArray(message.tool_calls)
        ? (message.tool_calls as Array<{
            function?: { index?: number; name?: string; arguments?: unknown };
          }>)
        : [];
      for (const toolCall of toolCalls) {
        const index =
          typeof toolCall.function?.index === "number"
            ? toolCall.function.index
            : pendingCalls.size;
        const pending = pendingCalls.get(index) ?? {
          id: `ollama_tool_${index}_${crypto.randomUUID()}`,
          name: "",
          arguments: "",
        };
        if (toolCall.function?.name) {
          pending.name = toolCall.function.name;
        }
        if (toolCall.function?.arguments !== undefined) {
          pending.arguments = JSON.stringify(toolCall.function.arguments);
        }
        pendingCalls.set(index, pending);
      }

      if (chunk.done === true) {
        const doneReason = chunk.done_reason;
        if (typeof doneReason === "string" && doneReason) {
          finishReason = doneReason;
        } else if (pendingCalls.size > 0) {
          finishReason = "tool_calls";
        }
      }
    }

    const toolCalls = [...pendingCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => ({
        id: toolCall.id,
        type: "function" as const,
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }));

    return {
      message: {
        role: "assistant",
        content: content || null,
        thinking: thinking || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finishReason: toolCalls.length > 0 ? "tool_calls" : finishReason,
    };
  }

  const response = await fetch(getOpenAICompatibleChatCompletionsUrl(options.provider), {
    method: "POST",
    headers: getOpenAICompatibleHeaders(options.provider),
    body: JSON.stringify({
      model: options.provider.model,
      messages: options.messages,
      tools: options.tools,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const label = options.provider.provider === "openrouter" ? "OpenRouter" : "Ollama";
    throw new Error(`${label} ${response.status}: ${await response.text()}`);
  }

  const pendingCalls = new Map<number, PartialToolCall>();
  let content = "";
  let finishReason = "stop";

  for await (const chunk of parseSSE(response.body)) {
    const choices = chunk.choices as
      | Array<{
          delta: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>
      | undefined;

    if (!choices?.length) continue;
    const { delta, finish_reason } = choices[0]!;

    if (finish_reason) finishReason = finish_reason;

    if (delta.content) {
      content += delta.content;
      await options.onText?.(delta.content);
    }

    for (const tc of delta.tool_calls ?? []) {
      let pending = pendingCalls.get(tc.index);
      if (!pending) {
        pending = {
          id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        };
        pendingCalls.set(tc.index, pending);
      } else {
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name += tc.function.name;
        if (tc.function?.arguments) pending.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = [...pendingCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

  return {
    message: {
      role: "assistant",
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turns a model tool call into a shell command for the bash sandbox. `bash`
 * carries the full command line in `command`. Small models frequently name a
 * CLI command directly as the tool (js-exec, vektor, recipes, …) and put the
 * payload in `command`/`code`/`script`/`input`; rebuild a runnable line from
 * the tool name and that payload instead of rejecting it.
 */
export function buildShellCommand(toolName: string, args: unknown): string {
  const record = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  if (toolName === "bash") return str(record.command);

  const payload =
    str(record.command) ||
    str(record.code) ||
    str(record.script) ||
    str(record.input) ||
    str(record.query) ||
    str(record.args) ||
    (typeof args === "string" ? (args as string).trim() : "");

  if (!payload) return toolName;
  if (payload === toolName || payload.startsWith(`${toolName} `)) return payload;
  // js-exec runs inline code with -c; a bare positional would be read as a path.
  if (toolName === "js-exec") return `js-exec -c ${shellQuote(payload)}`;
  return `${toolName} ${payload}`;
}

/** Best-effort lookup of a document's type for prompt tailoring. */
async function fetchDocumentType(
  apiUrl: string,
  spaceId: string,
  documentId: string,
  jobToken: string,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${apiUrl.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/documents/${encodeURIComponent(documentId)}`,
      { headers: { "X-Job-Token": jobToken } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { document?: { type?: string | null } };
    return data.document?.type ?? null;
  } catch {
    return null;
  }
}

export async function runAgentPrompt(options: {
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  documentType?: string | null;
  connectedProviders?: string[];
  userProfile?: string;
  jobToken: string;
  bash?: Bash;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void | Promise<void>;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentResult> {
  const {
    messages,
    spaceId,
    documentId,
    connectedProviders,
    userProfile,
    jobToken,
    bash: providedBash,
    apiUrl,
    signal,
    onChunk,
    onEvent,
  } = options;

  const provider = getAIProvider();

  // Resolve the document type so the system prompt can inline the right
  // editing playbook. Use the caller-provided type, else fetch once
  // (best-effort — a failure just falls back to the generic HTML playbook).
  let documentType = options.documentType;
  if (documentType === undefined && documentId) {
    documentType = await fetchDocumentType(apiUrl, spaceId, documentId, jobToken);
  }

  const mcpConfig: VektorMcpConfig = {
    apiUrl,
    spaceId,
    jobToken,
    documentId,
    connectedProviders,
  };
  const bash =
    providedBash ?? createAgentShell({ current: mcpConfig }, undefined, provider);
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        description: "Execute bash in isolated in-memory environment.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
  ];

  const agentMessages: ChatMessage[] = [
    {
      role: "system",
      content: buildCoreAgentSystemPrompt(
        documentId,
        connectedProviders,
        userProfile,
        documentType,
      ),
    },
    ...messages,
  ];
  const allChunks: string[] = [];

  while (true) {
    const { message, finishReason } = await callModel({
      provider,
      messages: agentMessages,
      tools,
      signal,
      onText: async (text) => {
        allChunks.push(text);
        await onEvent?.({ type: "text", text });
        await onChunk?.(text);
      },
      onThinking: async (text) => {
        await onEvent?.({ type: "thinking", text });
      },
    });

    agentMessages.push(message);

    if (!message.tool_calls?.length) {
      return { content: allChunks.join(""), stopReason: finishReason };
    }

    for (const toolCall of message.tool_calls) {
      await onEvent?.({
        type: "tool_call",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        toolArguments: toolCall.function.arguments,
      });

      let result: unknown;
      let isError = false;
      try {
        const args = JSON.parse(toolCall.function.arguments || "{}") as unknown;
        // The only real tool is `bash`. Small models often call a shell
        // command directly as a "tool" (e.g. js-exec, vektor, recipes); route
        // any tool call through bash by reconstructing the command line rather
        // than failing with "Unknown tool".
        const cmd = buildShellCommand(toolCall.function.name, args);
        if (!cmd) {
          throw new Error('No command provided. Call bash with {"command": "…"}.');
        }
        const res = await bash.exec(cmd);
        const stdout = res.stdout.trim();
        const stderr = res.stderr.trim();
        const output = [stdout, stderr ? `stderr: ${stderr}` : ""]
          .filter(Boolean)
          .join("\n");
        if (res.exitCode !== 0) {
          result =
            output ||
            `Command failed with exit code ${res.exitCode}. Command may have redirected stderr or command may not exist.`;
        } else {
          result = output || "(no output)";
        }
        isError = res.exitCode !== 0;
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);
      }

      const content =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);

      // Full content goes to the client for display.
      await onEvent?.({
        type: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content,
        isError,
      });

      // Truncate before adding to the LLM context window.
      // Large tool outputs flood the context and cause the model to lose
      // coherence.  The truncation message instructs the model to redirect
      // output to a file when it needs to process more data.
      const MAX_TOOL_RESULT_CHARS = 6_000;
      const modelContent =
        content.length > MAX_TOOL_RESULT_CHARS
          ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[Output truncated — ${(content.length - MAX_TOOL_RESULT_CHARS).toLocaleString()} more characters not shown. Redirect to a file and process it there: e.g. \`command > output.json && jq '...'  output.json\`]`
          : content;

      agentMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: modelContent,
      });
    }
  }
}

export function createAgentShell(
  mcpConfigRef: { current: VektorMcpConfig },
  bootstrap?: AgentShellBootstrap,
  completion?: AIProvider,
): Bash {
  return new Bash({
    cwd: bootstrap?.cwd,
    env: bootstrap?.env,
    network: { dangerouslyAllowFullInternetAccess: true },
    customCommands: [
      zipCommand,
      zipinfoCommand,
      unzipCommand,
      vektorCommand(mcpConfigRef),
      recipesCommand(),
      htmlToCsvCommand,
      htmlTableToCsvCommand,
      uploadCommand(mcpConfigRef),
      aiCommand(completion),
      ...(!mcpConfigRef.current.connectedProviders ||
      mcpConfigRef.current.connectedProviders.includes("gitlab")
        ? [gitlabCommand(mcpConfigRef)]
        : []),
      extensionCommand(mcpConfigRef),
      curlCommand,
      jsExecCommand,
      ...runtimeStubCommands,
    ],
  });
}
