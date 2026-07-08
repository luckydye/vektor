import { Bash } from "just-bash";
import { getAIProvider } from "#db/aiConfig.ts";
import { getAgentSearchUrl } from "#db/searchConfig.ts";
import { callAnthropic } from "#provider/anthropic.ts";
import { callOllama } from "#provider/ollama.ts";
import { callOpenAICompatible } from "#provider/openaiCompatible.ts";
import type { AIProvider, ChatMessage } from "#provider/types.ts";
import {
  callTool as callVektorTool,
  listTools as listVektorTools,
  type VektorMcpConfig,
} from "#utils/vektorMcp.ts";
import { curlCommand } from "./commands/curl.ts";
import { extensionCommand } from "./commands/extension.ts";
import { gitlabCommand } from "./commands/gitlab.ts";
import { htmlTableToCsvCommand, htmlToCsvCommand } from "./commands/htmlToCsv.ts";
import { jsExecCommand } from "./commands/jsExec.ts";
import systemPromptRaw from "./commands/recipes/system-prompt.txt" with { type: "text" };
import { getRecipe, recipesCommand } from "./commands/recipes.ts";
import { runtimeStubCommands } from "./commands/runtimeStubs.ts";
import { uploadCommand } from "./commands/upload.ts";
import { runWebSearchTool } from "./commands/websearch.ts";
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
  searchConfigured?: boolean,
) {
  const gitlabConnected = !connectedProviders || connectedProviders.includes("gitlab");
  const gitlabLine = gitlabConnected
    ? "- GitLab: prefer `integration_api_request` for API calls. The `gitlab ls/cat/tree <project> [path] [--ref <ref>]` shell commands are available for repository files.\n"
    : "";
  const websearchLine = searchConfigured
    ? "- Use the `websearch` tool to search the web; it returns ranked title/url/snippet. Find pages with it, then `curl` to read them.\n"
    : "";
  return `${systemPromptRaw}${gitlabLine}${websearchLine}${documentEditingSection(documentId, documentType)}${userProfile ? `\n\n## User Profile\n${userProfile}` : ""}`;
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

  const recipeName = recipeForDocumentType(documentType);
  const recipe = getRecipe(recipeName);

  return `
## Editing the current document
- "this document" / "the page" = document ID \`${documentId}\`. Read it first with \`get_current_document\`.
- To change it, ALWAYS use \`edit_document\` with documentId \`${documentId}\`. NEVER edit document content with
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
  const provider = options.provider;
  if (provider.provider === "anthropic") {
    return callAnthropic({ ...options, provider });
  }
  if (provider.provider === "ollama") {
    return callOllama({ ...options, provider });
  }
  return callOpenAICompatible({ ...options, provider });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function listFiles(
  bash: Bash,
  requestedPath: string,
  recursive: boolean,
): Promise<string> {
  const rootPath = bash.fs.resolvePath(bash.getCwd(), requestedPath);
  const rootStat = await bash.fs.lstat(rootPath);
  if (!rootStat.isDirectory) {
    throw new Error(`list_files path is not a directory: ${requestedPath}`);
  }

  const entriesAt = async (directoryPath: string) => {
    const names = await bash.fs.readdir(directoryPath);
    return names.sort((left, right) => left.localeCompare(right));
  };
  const describeEntry = async (directoryPath: string, name: string) => {
    const entryPath = bash.fs.resolvePath(directoryPath, name);
    const stat = await bash.fs.lstat(entryPath);
    if (stat.isDirectory) return { entryPath, label: `${name}/`, isDirectory: true };
    if (stat.isSymbolicLink) {
      return {
        entryPath,
        label: `${name} -> ${await bash.fs.readlink(entryPath)}`,
        isDirectory: false,
      };
    }
    return { entryPath, label: name, isDirectory: false };
  };

  const rootEntries = await entriesAt(rootPath);
  if (!recursive) {
    if (rootEntries.length === 0) return "(empty directory)";
    const labels = await Promise.all(
      rootEntries.map(async (name) => (await describeEntry(rootPath, name)).label),
    );
    return labels.join("\n");
  }

  const rootLabel =
    requestedPath === "."
      ? "."
      : requestedPath.endsWith("/")
        ? requestedPath
        : `${requestedPath}/`;
  const lines = [rootLabel];
  const walk = async (directoryPath: string, prefix: string): Promise<void> => {
    const names = await entriesAt(directoryPath);
    for (const [index, name] of names.entries()) {
      const isLast = index === names.length - 1;
      const entry = await describeEntry(directoryPath, name);
      lines.push(`${prefix}${isLast ? "└── " : "├── "}${entry.label}`);
      if (entry.isDirectory) {
        await walk(entry.entryPath, `${prefix}${isLast ? "    " : "│   "}`);
      }
    }
  };
  await walk(rootPath, "");
  return lines.join("\n");
}

/**
 * Turns a model tool call into a shell command for the bash sandbox. `bash`
 * carries the full command line in `command`. Small models frequently name a
 * CLI command directly as the tool (js-exec, recipes, …) and put the
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

  const provider = options.provider ?? (await getAIProvider(spaceId));
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
  const bash = providedBash ?? createAgentShell({ current: mcpConfig });
  const vektorTools = await listVektorTools(mcpConfig);
  const vektorToolNames = new Set(vektorTools.map((tool) => tool.name));
  // Only advertise websearch when the space has a search endpoint configured.
  const searchConfigured = Boolean(await getAgentSearchUrl(spaceId));
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
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List entries in a directory in the isolated in-memory filesystem. Set recursive to true to return a complete file tree. Use this instead of ls or find.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                'Directory path, absolute or relative to the current directory. Defaults to ".".',
              default: ".",
            },
            recursive: {
              type: "boolean",
              description: "List the complete nested tree instead of immediate entries.",
              default: false,
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a UTF-8 text file from the isolated in-memory filesystem. Use this instead of cat.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path, absolute or relative to the current directory.",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write UTF-8 text directly to the isolated in-memory filesystem. Use this instead of shell redirection, printf, or cat. Overwrites by default; set mode to append only when preserving existing content is required.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path, absolute or relative to the current directory.",
            },
            content: {
              type: "string",
              description: "Exact text to write; no shell escaping is needed.",
            },
            mode: {
              type: "string",
              enum: ["overwrite", "append"],
              description: "Whether to replace the file or append to it.",
              default: "overwrite",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    ...(searchConfigured
      ? [
          {
            type: "function",
            function: {
              name: "websearch",
              description:
                "Search the web via the space's configured search endpoint. Returns ranked results (title, URL, snippet). Use it to find pages, then read a page with the bash `curl` command.",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string", description: "The search query." },
                  count: {
                    type: "integer",
                    description: "Maximum number of results to return (1–20).",
                    default: 8,
                  },
                },
                required: ["query"],
              },
            },
          },
        ]
      : []),
    ...vektorTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  ];

  const agentMessages: ChatMessage[] = [
    {
      role: "system",
      content: buildCoreAgentSystemPrompt(
        documentId,
        connectedProviders,
        userProfile,
        documentType,
        searchConfigured,
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
            "Continue the requested task now. Use the available structured tools for Vektor and filesystem work, and bash for commands; do not only describe or plan the action. Otherwise provide a visible answer.",
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
        const record = (args && typeof args === "object" ? args : {}) as Record<
          string,
          unknown
        >;

        if (toolCall.function.name === "list_files") {
          const path = record.path ?? ".";
          const recursive = record.recursive ?? false;
          if (typeof path !== "string" || !path.trim()) {
            throw new Error('list_files "path" must be a non-empty string.');
          }
          if (typeof recursive !== "boolean") {
            throw new Error('list_files "recursive" must be a boolean.');
          }
          result = await listFiles(bash, path, recursive);
        } else if (toolCall.function.name === "read_file") {
          const path = record.path;
          if (typeof path !== "string" || !path.trim()) {
            throw new Error('read_file requires a non-empty "path".');
          }
          const resolvedPath = bash.fs.resolvePath(bash.getCwd(), path);
          result = await bash.fs.readFile(resolvedPath, "utf8");
        } else if (toolCall.function.name === "write_file") {
          const path = record.path;
          const content = record.content;
          const mode = record.mode ?? "overwrite";
          if (typeof path !== "string" || !path.trim()) {
            throw new Error('write_file requires a non-empty "path".');
          }
          if (typeof content !== "string") {
            throw new Error('write_file requires string "content".');
          }
          if (mode !== "overwrite" && mode !== "append") {
            throw new Error('write_file "mode" must be "overwrite" or "append".');
          }
          const resolvedPath = bash.fs.resolvePath(bash.getCwd(), path);
          if (mode === "append") {
            await bash.fs.appendFile(resolvedPath, content, "utf8");
          } else {
            await bash.fs.writeFile(resolvedPath, content, "utf8");
          }
          result = `${mode === "append" ? "Appended" : "Wrote"} ${Buffer.byteLength(content, "utf8")} bytes to ${resolvedPath}.`;
        } else if (toolCall.function.name === "websearch") {
          result = await runWebSearchTool(spaceId, record);
        } else if (vektorToolNames.has(toolCall.function.name)) {
          result = await callVektorTool(mcpConfig, toolCall.function.name, record);
        } else {
          // Small models sometimes call a shell command directly as a "tool"
          // (e.g. js-exec, recipes). Route unknown tool names through
          // bash by reconstructing the command line for backwards compatibility.
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
        }
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
): Bash {
  return new Bash({
    cwd: bootstrap?.cwd,
    env: bootstrap?.env,
    network: { dangerouslyAllowFullInternetAccess: true },
    customCommands: [
      zipCommand,
      zipinfoCommand,
      unzipCommand,
      recipesCommand(),
      htmlToCsvCommand,
      htmlTableToCsvCommand,
      uploadCommand(mcpConfigRef),
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
