import AdmZip from "adm-zip";
import { Bash, defineCommand } from "just-bash";
import * as html5parser from "html5parser";
import { dirname, posix } from "node:path";
import { config, getConfiguredOpenRouterModel } from "../config.ts";
import { callTool as callVektorTool } from "../utils/vektorMcp.ts";
import type { VektorMcpConfig } from "../utils/vektorMcp.ts";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
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

const CORE_AGENT_SYSTEM_PROMPT = `## Bash Tool Runtime
The bash tool runs inside bash, not full system shell.
- Do not assume node, npm, npx, pnpm, bun, pip, or python exist.
- zip and unzip are available and operate on virtual filesystem. Always recursive — no flags needed. Examples: \`zip archive.zip file.txt dir/\`, \`unzip archive.zip -d output/\`.
- vektor command is available in bash for document access. Use it when shell piping or redirection into virtual files is useful.
- pandoc command is available for focused conversions in virtual filesystem: html -> csv (first table) and html-table -> csv.
- To fetch non-current documents: run \`vektor search "<query>" --json\` or \`vektor list --json\`, extract document \`id\`, then run \`vektor read <id>\`.
- Use \`vektor current\` only for current chat document context.
- To save document output into virtual filesystem, use shell redirection. Examples: \`vektor current > current-doc.txt\`, \`vektor read <id> > doc.md\`, \`vektor search "auth" --json > results.json\`.
- upload command is available to upload a file from virtual filesystem: \`upload <file> [-t content-type] [-d document-id]\`. Returns JSON with upload result including URL.
- Prefer direct shell utilities already available in bash.
- If command fails, inspect error output and adapt. Do not assume missing commands exist on retry.
- To loop over lines in a file, use \`done < file.txt\` (single \`<\`). The \`<<\` operator is a heredoc and reads inline text, not a file. Correct pattern: \`while read -r line; do echo "$line"; done < file.txt\`

## Behavior
- Be concise, accurate, and tool-driven.
- Explain briefly what you are about to do before using tools.

## App Documents
- Documents with type "app" are HTML apps in sandboxed iframes.
- To create one, create document with full HTML and type "app".
- To update one, replace running HTML content in the document.

## Current Document
- When user asks about "this document", "the page", or current content, inspect it first with \`vektor current\`.`;

async function addPathToZip(
  zip: AdmZip,
  sourcePath: string,
  archivePath: string,
  fs: Parameters<typeof defineCommand>[1] extends (
    args: string[],
    ctx: infer Ctx,
  ) => Promise<unknown>
    ? Ctx["fs"]
    : never,
) {
  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory) {
    const normalizedArchivePath = archivePath.endsWith("/")
      ? archivePath
      : `${archivePath}/`;
    zip.addFile(normalizedArchivePath, Buffer.alloc(0));
    for (const entry of await fs.readdir(sourcePath)) {
      await addPathToZip(
        zip,
        fs.resolvePath(sourcePath, entry),
        posix.join(archivePath, entry),
        fs,
      );
    }
    return;
  }

  zip.addFile(archivePath, Buffer.from(await fs.readFileBuffer(sourcePath)));
}

const zipCommand = defineCommand("zip", async (args, ctx) => {
  const filteredArgs = args.filter((arg) => !arg.startsWith("-"));
  if (filteredArgs.length < 2) {
    return {
      stdout: "",
      stderr: "usage: zip archive.zip <path...>\n",
      exitCode: 2,
    };
  }

  const [archiveArg, ...inputArgs] = filteredArgs;
  const archivePath = ctx.fs.resolvePath(ctx.cwd, archiveArg);
  const zip = new AdmZip();

  for (const inputArg of inputArgs) {
    const inputPath = ctx.fs.resolvePath(ctx.cwd, inputArg);
    if (!(await ctx.fs.exists(inputPath))) {
      return {
        stdout: "",
        stderr: `zip: ${inputArg}: No such file or directory\n`,
        exitCode: 1,
      };
    }
    await addPathToZip(zip, inputPath, posix.basename(inputArg), ctx.fs);
  }

  await ctx.fs.writeFile(archivePath, new Uint8Array(zip.toBuffer()), "binary");
  return {
    stdout: `created ${archiveArg}\n`,
    stderr: "",
    exitCode: 0,
  };
});

const unzipCommand = defineCommand("unzip", async (args, ctx) => {
  if (args.length === 0) {
    return {
      stdout: "",
      stderr: "usage: unzip archive.zip [-d destination]\n",
      exitCode: 2,
    };
  }

  const archiveArg = args[0];
  let destinationArg = ".";
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-d") {
      destinationArg = args[index + 1] ?? ".";
      index++;
      continue;
    }
    return {
      stdout: "",
      stderr: `unzip: unsupported argument '${arg}'\n`,
      exitCode: 2,
    };
  }

  const archivePath = ctx.fs.resolvePath(ctx.cwd, archiveArg);
  if (!(await ctx.fs.exists(archivePath))) {
    return {
      stdout: "",
      stderr: `unzip: ${archiveArg}: No such file or directory\n`,
      exitCode: 1,
    };
  }

  const destinationPath = ctx.fs.resolvePath(ctx.cwd, destinationArg);
  await ctx.fs.mkdir(destinationPath, { recursive: true });

  const zip = new AdmZip(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));
  for (const entry of zip.getEntries()) {
    const outputPath = ctx.fs.resolvePath(destinationPath, entry.entryName);
    if (entry.isDirectory) {
      await ctx.fs.mkdir(outputPath, { recursive: true });
      continue;
    }
    await ctx.fs.mkdir(dirname(outputPath), { recursive: true });
    await ctx.fs.writeFile(outputPath, new Uint8Array(entry.getData()), "binary");
  }

  return {
    stdout: `extracted ${archiveArg} to ${destinationArg}\n`,
    stderr: "",
    exitCode: 0,
  };
});

function formatVektorValue(value: unknown, json: boolean): string {
  if (json || typeof value === "string") {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatVektorValue(item, false)).join("\n\n");
  }

  if (!value || typeof value !== "object") {
    return String(value);
  }

  const record = value as Record<string, unknown>;

  if (Array.isArray(record.documents)) {
    return record.documents
      .map((item, index) => {
        const doc = item as Record<string, unknown>;
        const title =
          typeof doc.title === "string"
            ? doc.title
            : typeof doc.slug === "string"
              ? doc.slug
              : `document-${index + 1}`;
        const lines = [title];
        if (typeof doc.id === "string") lines.push(`id: ${doc.id}`);
        if (typeof doc.slug === "string") lines.push(`slug: ${doc.slug}`);
        if (typeof doc.type === "string") lines.push(`type: ${doc.type}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  const title =
    typeof record.title === "string"
      ? record.title
      : typeof record.slug === "string"
        ? record.slug
        : null;
  const lines: string[] = [];
  if (title) lines.push(title);
  if (typeof record.id === "string") lines.push(`id: ${record.id}`);
  if (typeof record.slug === "string") lines.push(`slug: ${record.slug}`);
  if (typeof record.type === "string") lines.push(`type: ${record.type}`);
  if (typeof record.content === "string") {
    lines.push("");
    lines.push(record.content);
  }
  if (lines.length > 0) {
    return lines.join("\n");
  }

  return JSON.stringify(record, null, 2);
}

type HtmlTagNode = html5parser.ITag;
type HtmlNode = html5parser.INode;

function isTag(node: HtmlNode, name?: string): node is HtmlTagNode {
  return (
    node.type === html5parser.SyntaxKind.Tag &&
    (name ? node.name.toLowerCase() === name : true)
  );
}

function getNodeText(node: HtmlNode): string {
  if (node.type === html5parser.SyntaxKind.Text) {
    return node.value;
  }
  if (!isTag(node) || !node.body) {
    return "";
  }
  return node.body.map(getNodeText).join("");
}

function normalizeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstTag(nodes: HtmlNode[], name: string): HtmlTagNode | null {
  for (const node of nodes) {
    if (isTag(node, name)) {
      return node;
    }
    if (isTag(node) && node.body) {
      const nested = findFirstTag(node.body, name);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function collectChildTags(node: HtmlTagNode, names: string[]): HtmlTagNode[] {
  const result: HtmlTagNode[] = [];
  const allowed = new Set(names.map((name) => name.toLowerCase()));
  for (const child of node.body ?? []) {
    if (isTag(child) && allowed.has(child.name.toLowerCase())) {
      result.push(child);
    }
  }
  return result;
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function convertHtmlTableToCsv(html: string): string {
  const ast = html5parser.parse(html);
  const table = findFirstTag(ast, "table");
  if (!table) {
    throw new Error("No <table> found in HTML input");
  }

  const rows = (table.body ?? []).flatMap((child) => {
    if (isTag(child, "thead") || isTag(child, "tbody") || isTag(child, "tfoot")) {
      return collectChildTags(child, ["tr"]);
    }
    return isTag(child, "tr") ? [child] : [];
  });

  if (rows.length === 0) {
    throw new Error("HTML table contains no rows");
  }

  return rows
    .map((row) =>
      collectChildTags(row, ["th", "td"])
        .map((cell) => escapeCsvCell(normalizeHtmlText(getNodeText(cell))))
        .join(","),
    )
    .join("\n");
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

type PartialToolCall = { id: string; name: string; arguments: string };

async function callModel(options: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}): Promise<{ message: ChatMessage; finishReason: string }> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
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

  const apiKey = config().OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
  const model = getConfiguredOpenRouterModel();

  const mcpConfig: VektorMcpConfig = { apiUrl, spaceId, jobToken, documentId };
  const bash = providedBash ?? createAgentShell({ current: mcpConfig });
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
    { role: "system", content: CORE_AGENT_SYSTEM_PROMPT },
    ...messages,
  ];
  const allChunks: string[] = [];

  while (true) {
    await onEvent?.({ type: "status", text: "Thinking..." });
    const { message, finishReason } = await callModel({
      apiKey,
      model,
      messages: agentMessages,
      tools,
      signal,
      onText: async (text) => {
        allChunks.push(text);
        await onEvent?.({ type: "text", text });
        await onChunk?.(text);
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
): Bash {
  const uploadCommand = defineCommand("upload", async (args, ctx) => {
    const usage = "usage: upload <file> [-t content-type] [-d document-id]\n";

    let contentType: string | undefined;
    let documentId: string | undefined;
    let fileArg: string | undefined;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-t") {
        contentType = args[++index];
        continue;
      }
      if (arg === "-d") {
        documentId = args[++index];
        continue;
      }
      fileArg = arg;
    }

    if (!fileArg) {
      return { stdout: "", stderr: usage, exitCode: 2 };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, fileArg);
    if (!(await ctx.fs.exists(filePath))) {
      return { stdout: "", stderr: `upload: ${fileArg}: No such file or directory\n`, exitCode: 1 };
    }

    const bytes = await ctx.fs.readFileBuffer(filePath);
    const content = Buffer.from(bytes).toString("base64");
    const filename = posix.basename(filePath);

    const result = await callVektorTool(mcpConfigRef.current, "upload_artifact", {
      filename,
      content,
      encoding: "base64",
      ...(contentType ? { contentType } : {}),
      ...(documentId ? { documentId } : {}),
    });

    return {
      stdout: `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });

  const vektorCommand = defineCommand("vektor", async (args, _ctx) => {
    const json = args.includes("--json");
    const commandArgs = args.filter((arg) => arg !== "--json");
    const [subcommand, ...rest] = commandArgs;

    if (!subcommand) {
      return {
        stdout: "",
        stderr:
          "usage: vektor <list|read|current|search> [args] [--json]\n" +
          "fetch other docs: vektor search \"query\" --json -> take id -> vektor read <id>\n" +
          "fetch current doc: vektor current\n" +
          "save to file: vektor read <id> > doc.md\n",
        exitCode: 2,
      };
    }

    let result: unknown;
    switch (subcommand) {
      case "list":
        result = await callVektorTool(mcpConfigRef.current, "list_documents", {});
        break;
      case "read":
        if (!rest[0]) {
          return {
            stdout: "",
            stderr: "usage: vektor read <document-id> [--json]\n",
            exitCode: 2,
          };
        }
        result = await callVektorTool(mcpConfigRef.current, "get_document", {
          documentId: rest[0],
        });
        break;
      case "current":
        result = await callVektorTool(mcpConfigRef.current, "get_current_document", {});
        break;
      case "search":
        if (!rest.length) {
          return {
            stdout: "",
            stderr: "usage: vektor search <query> [--json]\n",
            exitCode: 2,
          };
        }
        result = await callVektorTool(mcpConfigRef.current, "search_documents", {
          q: rest.join(" "),
        });
        break;
      default:
        return {
          stdout: "",
          stderr: `vektor: unknown subcommand '${subcommand}'\n`,
          exitCode: 2,
        };
    }

    return {
      stdout: `${formatVektorValue(result, json)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });

  const pandocCommand = defineCommand("pandoc", async (args, ctx) => {
    const usage =
      "usage: pandoc -f <html|html-table> -t csv [input-file] [-o output-file]\n" +
      "examples:\n" +
      "  pandoc -f html -t csv table.html > table.csv\n" +
      "  pandoc -f html-table -t csv table.html > table.csv\n";

    let from: string | null = null;
    let to: string | null = null;
    let outputFile: string | null = null;
    const positional: string[] = [];

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-f" || arg === "--from") {
        from = args[++index] ?? null;
        continue;
      }
      if (arg === "-t" || arg === "--to") {
        to = args[++index] ?? null;
        continue;
      }
      if (arg === "-o" || arg === "--output") {
        outputFile = args[++index] ?? null;
        continue;
      }
      positional.push(arg);
    }

    if (!to) {
      return { stdout: "", stderr: `${usage}`, exitCode: 2 };
    }
    if (!from && positional[0]) {
      const ext = posix.extname(positional[0]).slice(1).toLowerCase();
      from = ext || null;
    }
    from ??= "html";

    const inputPath = positional[0]
      ? ctx.fs.resolvePath(ctx.cwd, positional[0])
      : null;
    const inputBytes = inputPath
      ? await ctx.fs.readFileBuffer(inputPath)
      : new TextEncoder().encode(ctx.stdin);

    if ((from === "html-table" || from === "html") && to === "csv") {
      const csv = convertHtmlTableToCsv(Buffer.from(inputBytes).toString("utf-8"));
      if (outputFile) {
        const outputPath = ctx.fs.resolvePath(ctx.cwd, outputFile);
        await ctx.fs.writeFile(outputPath, csv, "utf8");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: `${csv}\n`, stderr: "", exitCode: 0 };
    }

    throw new Error(`Unsupported conversion: ${from} -> ${to}`);
  });

  return new Bash({
    cwd: bootstrap?.cwd,
    env: bootstrap?.env,
    customCommands: [zipCommand, unzipCommand, vektorCommand, pandocCommand, uploadCommand],
  });
}
