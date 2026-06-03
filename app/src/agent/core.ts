import { Bash } from "just-bash";
import {
  config,
  getConfiguredAnthropicModel,
  getConfiguredOllamaBaseUrl,
  getConfiguredOllamaModel,
  getConfiguredOpenRouterModel,
} from "../config.ts";
import type { VektorMcpConfig } from "../utils/vektorMcp.ts";
import {
  zipCommand,
  zipinfoCommand,
  unzipCommand,
} from "./commands/zip.ts";
import { vektorCommand } from "./commands/vektor.ts";
import { pandocCommand } from "./commands/pandoc.ts";
import { uploadCommand } from "./commands/upload.ts";
import { aiCommand } from "./commands/ai.ts";
import { gitlabCommand } from "./commands/gitlab.ts";
import { curlCommand } from "./commands/curl.ts";
import { extensionCommand } from "./commands/extension.ts";
import { jsExecCommand } from "./commands/jsExec.ts";

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

function buildCoreAgentSystemPrompt(documentId?: string) {
  return `## Bash Tool Runtime
The bash tool runs inside bash, not full system shell.
- js-exec is available for JavaScript/TypeScript execution in a QuickJS sandbox. Use \`js-exec -c "..."\` for inline scripts, \`js-exec script.js\` for files. Has \`console\`, \`process\` (argv, cwd, env, platform), and basic globals. No \`require\`, \`fetch\`, or Node.js built-in modules inside the sandbox. Default timeout: 10s.
- zip and unzip are available and operate on virtual filesystem. Always recursive — no flags needed. Examples: \`zip archive.zip file.txt dir/\`, \`unzip archive.zip -d output/\`.
- zipinfo lists zip contents: \`zipinfo archive.zip\`. Use this instead of \`unzip -l\`.
- vektor command is available in bash for document access. Use it when shell piping or redirection into virtual files is useful.
- Create docs with \`vektor create --title "Title" [--type type] [--parent document-id] [file]\`. If no file is given, content is read from stdin. Example: \`cat app.html | vektor create --title "Dashboard" --type app\`.
- Delete docs with \`vektor delete <id>\` or \`vektor delete <id> --permanent\`.
- pandoc command is available for focused conversions in virtual filesystem: html -> csv (first table) and html-table -> csv. Example: \`vektor current > doc.html && pandoc doc.html -t csv -o table.csv\`.
- To fetch non-current documents: run \`vektor search "<query>" --json\` or \`vektor list --json\`, extract document \`id\`, then run \`vektor read <id>\`.
- Use \`vektor current\` only for current chat document context.
- To save document output into virtual filesystem, use shell redirection. Examples: \`vektor current > current-doc.txt\`, \`vektor read <id> > doc.md\`, \`vektor search "auth" --json > results.json\`.
- upload command is available to upload a file from virtual filesystem: \`upload <file> [-t content-type] [-d document-id]\`. Returns JSON with upload result including URL.
- Never give the user sandbox paths (e.g. sandbox:/file.zip). Always upload files first with \`upload\` and give the user the resulting URL.
- Use human-readable filenames for uploaded files (e.g. the document title, not the document ID).
- Only include final output files in zips. Delete or exclude intermediate files (e.g. downloaded HTML used to produce CSVs) before zipping.
- ai command is available for one-shot AI completions: \`ai <prompt>\` or \`echo <prompt> | ai\`. Examples: \`ai "summarize this" < doc.txt\`, \`cat data.csv | ai "what are the trends?"\`.
- gitlab command is available for GitLab API requests using the current user's connected OAuth token. Paths are relative to /api/v4. Examples: \`gitlab /user\`, \`gitlab '/projects?membership=true&simple=true'\`, \`gitlab -X POST -H "Content-Type: application/json" -d '{"title":"Bug"}' /projects/123/issues\`.
- curl is available for HTTP requests. Use \`curl -s <url>\` for GET, \`curl -X POST -H "Content-Type: application/json" -d '{"key":"val"}' <url>\` for POST. Pipe output to \`html-to-markdown\` to convert pages to markdown.
- Prefer direct shell utilities already available in bash.
- If command fails, inspect error output and adapt. Do not assume missing commands exist on retry.
- To loop over lines in a file, use \`done < file.txt\` (single \`<\`). The \`<<\` operator is a heredoc and reads inline text, not a file. Correct pattern: \`while read -r line; do echo "$line"; done < file.txt\`
- Do not use \`awk -F,\` to parse CSV columns — quoted fields containing commas will shift column numbers. To extract doc IDs or other patterns from CSV or HTML, use \`grep -oE 'pattern'\` instead.

## Behavior
- Before starting, outline a short plan of steps.
- After each step, verify the result before continuing to the next step (e.g. check file exists, inspect output, confirm command succeeded).
- Do not report results to the user until they have been verified.

## App Documents
- Documents with type "app" are HTML apps in sandboxed iframes.
- To create one, create document with full HTML and type "app".
- To update one, replace running HTML content in the document.

## Extensions
- Extensions add UI and job functionality to the space. Use \`extension install <zip-file>\` to install.
- Extensions are ZIP packages with \`manifest.json\` at root and \`dist/\` with plain ESM JS — no build step needed.
- Minimum manifest.json: \`{"id":"my-ext","name":"My Extension","version":"1.0.0","entries":{"frontend":"dist/main.js"}}\`
- Extension IDs must be lowercase alphanumeric with hyphens only (e.g. \`my-extension\`).
- Frontend entry exports \`activate(ctx)\` and \`deactivate(ctx)\`. The \`ctx\` object provides:
  - \`ctx.actions.register(id, {title, icon?, async run(ctx)})\` — add command palette actions
  - \`ctx.suggestions.register(id, {char, items(query), onSelect(item, editor)})\` — add editor slash commands
  - \`ctx.views.register(path, (container) => { /* render UI into container */ })\` — render a page view
  - \`ctx.api\` — fetch API client for space/document operations
- Jobs run server-side in worker threads. Define in manifest: \`"jobs":[{"id":"my-job","name":"My Job","entry":"dist/jobs/my-job.js","inputs":{"text":{"type":"string","required":true}},"outputs":{"result":{"type":"string"}}}]\`
- Job entry uses worker_threads: \`const {parentPort,workerData}=require("node:worker_threads"); parentPort.postMessage({type:"result",success:true,outputs:{result:{type:"text",value:"..."}}});\`
- To create an extension: write manifest.json and dist/ files, \`zip ext.zip manifest.json dist/\`, then \`extension install ext.zip\`.

${documentId ? `\n## Current Document\n- When user asks about "this document", "the page", or current content, inspect it first with \`vektor current\`.` : ""}`;
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
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

async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
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
    return { provider: "ollama", baseUrl: getConfiguredOllamaBaseUrl(), model: getConfiguredOllamaModel() };
  }
  if (cfg.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: cfg.ANTHROPIC_API_KEY, model: getConfiguredAnthropicModel() };
  }
  if (cfg.OPENROUTER_API_KEY) {
    return { provider: "openrouter", apiKey: cfg.OPENROUTER_API_KEY, model: getConfiguredOpenRouterModel() };
  }
  throw new Error("No AI provider configured. Set OLLAMA_BASE_URL, ANTHROPIC_API_KEY, or OPENROUTER_API_KEY.");
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
        throw new Error(`Ollama tool message references unknown tool_call_id: ${message.tool_call_id}`);
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
        toolResults.push({ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" });
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
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      result.push({ role: "assistant", content: content.length === 1 && !msg.tool_calls?.length ? (msg.content ?? "") : content });
      i++;
      continue;
    }

    result.push({ role: "user", content: msg.content ?? "" });
    i++;
  }

  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: result };
}

type PartialToolCall = { id: string; name: string; arguments: string };

async function callModel(options: {
  provider: AIProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  if (options.provider.provider === "anthropic") {
    const { system, messages: anthropicMessages } = toAnthropicMessages(options.messages);
    const anthropicTools = (options.tools as Array<{
      function: { name: string; description?: string; parameters: unknown };
    }>).map(t => ({
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
        const block = (chunk as { content_block?: { type: string; id?: string; name?: string } }).content_block;
        if (block?.type === "tool_use") {
          toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: "" });
        }
      } else if (type === "content_block_delta") {
        const delta = (chunk as { delta?: { type?: string; text?: string; partial_json?: string } }).delta;
        if (delta?.type === "text_delta" && delta.text) {
          textContent += delta.text;
          await options.onText?.(delta.text);
        } else if (delta?.type === "input_json_delta" && delta.partial_json && toolCalls.length > 0) {
          toolCalls[toolCalls.length - 1]!.arguments += delta.partial_json;
        }
      } else if (type === "message_delta") {
        const stopReason = (chunk as { delta?: { stop_reason?: string } }).delta?.stop_reason;
        if (stopReason === "tool_use") finishReason = "tool_calls";
        else if (stopReason) finishReason = stopReason;
      }
    }

    return {
      message: {
        role: "assistant",
        content: textContent || null,
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map(tc => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } })),
        } : {}),
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
        ? (message.tool_calls as Array<{ function?: { index?: number; name?: string; arguments?: unknown } }>)
        : [];
      for (const toolCall of toolCalls) {
        const index = typeof toolCall.function?.index === "number"
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
        pending = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" };
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

export async function runAgentPrompt(options: {
  messages: ChatMessage[];
  apiUrl: string;
  spaceId: string;
  documentId?: string;
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
    jobToken,
    bash: providedBash,
    apiUrl,
    signal,
    onChunk,
    onEvent,
  } = options;

  const provider = getAIProvider();

  const mcpConfig: VektorMcpConfig = { apiUrl, spaceId, jobToken, documentId };
  const bash = providedBash ?? createAgentShell({ current: mcpConfig }, undefined, provider);
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
    { role: "system", content: buildCoreAgentSystemPrompt(documentId) },
    ...messages,
  ];
  const allChunks: string[] = [];

  while (true) {
    await onEvent?.({ type: "status", text: "Thinking..." });
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
      await onEvent?.({ type: "status", text: "Writing response..." });
      return { content: allChunks.join(""), stopReason: finishReason };
    }

    for (const toolCall of message.tool_calls) {
      await onEvent?.({
        type: "status",
        text: `Running ${toolCall.function.name}...`,
      });
      await onEvent?.({
        type: "tool_call",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        toolArguments: toolCall.function.arguments,
      });

      let result: unknown;
      let isError = false;
      try {
        const args = JSON.parse(toolCall.function.arguments) as unknown;
        if (toolCall.function.name === "bash") {
          const cmd = (args as { command: string }).command;
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
        } else {
          throw new Error(`Unknown tool: ${toolCall.function.name}`);
        }
      } catch (error) {
        isError = true;
        result = error instanceof Error ? error.message : String(error);
      }

      const content =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);

      await onEvent?.({
        type: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        content,
        isError,
      });
      await onEvent?.({
        type: "status",
        text: isError
          ? `${toolCall.function.name} failed`
          : `${toolCall.function.name} finished`,
      });

      agentMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content,
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
      pandocCommand,
      uploadCommand(mcpConfigRef),
      aiCommand(completion),
      gitlabCommand(mcpConfigRef),
      extensionCommand(mcpConfigRef),
      curlCommand,
      jsExecCommand,
    ],
  });
}
