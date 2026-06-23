import { Bash } from "just-bash";
import { getAIProvider } from "../db/aiConfig.ts";
import { callAnthropic } from "../provider/anthropic.ts";
import { callOllama } from "../provider/ollama.ts";
import { callOpenRouter } from "../provider/openrouter.ts";
import type { AIProvider, ChatMessage } from "../provider/types.ts";
import type { VektorMcpConfig } from "../utils/vektorMcp.ts";
import { aiCommand } from "./commands/ai.ts";
import { curlCommand } from "./commands/curl.ts";
import { extensionCommand } from "./commands/extension.ts";
import { gitlabCommand } from "./commands/gitlab.ts";
import { htmlTableToCsvCommand, htmlToCsvCommand } from "./commands/htmlToCsv.ts";
import { jsExecCommand } from "./commands/jsExec.ts";
import systemPromptRaw from "./commands/recipes/system-prompt.md" with { type: "text" };
import { getRecipe, recipesCommand } from "./commands/recipes.ts";
import { runtimeStubCommands } from "./commands/runtimeStubs.ts";
import { uploadCommand } from "./commands/upload.ts";
import { vektorCommand } from "./commands/vektor.ts";
import { unzipCommand, zipCommand, zipinfoCommand } from "./commands/zip.ts";

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
  const gitlabLine = gitlabConnected
    ? "- gitlab: `gitlab api <path>` (OAuth, relative to /api/v4); `gitlab ls/cat/tree <project> [path] [--ref <ref>]`. Use `gitlab api` to find projects.\n"
    : "";
  return `${systemPromptRaw}${gitlabLine}${documentEditingSection(documentId, documentType)}${userProfile ? `\n\n## User Profile\n${userProfile}` : ""}`;
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

export async function callModel(options: {
  provider: AIProvider;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  onThinking?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  if (options.provider.provider === "anthropic") {
    return callAnthropic(options);
  }
  if (options.provider.provider === "ollama") {
    return callOllama(options);
  }
  return callOpenRouter(options);
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
  /** Test seam for deterministic provider responses. */
  modelCaller?: typeof callModel;
  /** Test seam that avoids reading provider configuration. */
  provider?: AIProvider;
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

  const provider = options.provider ?? await getAIProvider(spaceId);
  const modelCaller = options.modelCaller ?? callModel;

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
  let emptyResponseRetries = 0;
  const maxEmptyResponseRetries = 2;

  while (true) {
    const { message, finishReason } = await modelCaller({
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
      if (!message.content?.trim()) {
        if (emptyResponseRetries >= maxEmptyResponseRetries) {
          throw new Error(
            `The model returned an empty response ${maxEmptyResponseRetries + 1} times.`,
          );
        }
        emptyResponseRetries += 1;
        await onEvent?.({
          type: "status",
          text: "Model planned an action but emitted no tool call; retrying.",
        });
        agentMessages.push({
          role: "user",
          content:
            "Continue the requested task now. If it requires a command, call the bash tool with the command; do not only describe or plan the action. Otherwise provide a visible answer.",
        });
        continue;
      }
      return { content: allChunks.join(""), stopReason: finishReason };
    }

    emptyResponseRetries = 0;

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
