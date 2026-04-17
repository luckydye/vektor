import AdmZip from "adm-zip";
import { Bash, defineCommand } from "just-bash";
import * as html5parser from "html5parser";
import { dirname, posix } from "node:path";
import { config, getConfiguredOpenRouterModel, getConfiguredAnthropicModel } from "../config.ts";
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

function buildCoreAgentSystemPrompt(documentId?: string) {
  return `## Bash Tool Runtime
The bash tool runs inside bash, not full system shell.
- Do not assume node, npm, npx, pnpm, bun, pip, or python exist.
- zip and unzip are available and operate on virtual filesystem. Always recursive — no flags needed. Examples: \`zip archive.zip file.txt dir/\`, \`unzip archive.zip -d output/\`.
- zipinfo lists zip contents: \`zipinfo archive.zip\`. Use this instead of \`unzip -l\`.
- vektor command is available in bash for document access. Use it when shell piping or redirection into virtual files is useful.
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

const zipinfoCommand = defineCommand("zipinfo", async (args, ctx) => {
  if (args.length === 0) {
    return { stdout: "", stderr: "usage: zipinfo archive.zip\n", exitCode: 2 };
  }
  const archivePath = ctx.fs.resolvePath(ctx.cwd, args[0]!);
  if (!(await ctx.fs.exists(archivePath))) {
    return { stdout: "", stderr: `zipinfo: ${args[0]}: No such file or directory\n`, exitCode: 1 };
  }
  const zip = new AdmZip(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));
  const lines = zip.getEntries().map((e) => {
    const size = e.header.size;
    const name = e.entryName;
    return `${e.isDirectory ? "d" : "-"} ${size.toString().padStart(10)} ${name}`;
  });
  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
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
  let list = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-d") {
      destinationArg = args[index + 1] ?? ".";
      index++;
      continue;
    }
    if (arg === "-l") {
      list = true;
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

  const zip = new AdmZip(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));

  if (list) {
    const lines = zip.getEntries().map((e) =>
      `${e.header.size.toString().padStart(10)} ${e.entryName}`
    );
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  const destinationPath = ctx.fs.resolvePath(ctx.cwd, destinationArg);
  await ctx.fs.mkdir(destinationPath, { recursive: true });

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

export type AIProvider = {
  provider: "openrouter" | "anthropic";
  apiKey: string;
  model: string;
};

export function getAIProvider(): AIProvider {
  const cfg = config();
  if (cfg.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: cfg.ANTHROPIC_API_KEY, model: getConfiguredAnthropicModel() };
  }
  if (cfg.OPENROUTER_API_KEY) {
    return { provider: "openrouter", apiKey: cfg.OPENROUTER_API_KEY, model: getConfiguredOpenRouterModel() };
  }
  throw new Error("No AI provider configured. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY.");
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

  // OpenRouter
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.provider.apiKey}`,
    },
    body: JSON.stringify({
      model: options.provider.model,
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
          "usage: vektor <list|read|current|search|delete> [args] [--json]\n" +
          "fetch other docs: vektor search \"query\" --json -> take id -> vektor read <id>\n" +
          "fetch current doc: vektor current\n" +
          "archive doc: vektor delete <id>\n" +
          "permanently delete doc: vektor delete <id> --permanent\n" +
          "save to file: vektor read <id> > doc.md\n",
        exitCode: 2,
      };
    }

    let result: unknown;
    switch (subcommand) {
      case "list":
        result = await callVektorTool(mcpConfigRef.current, "list_documents", {});
        break;
      case "read": {
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
        if (!json) {
          const doc = (result as Record<string, unknown>)?.document as Record<string, unknown> | undefined;
          const html = typeof doc?.content === "string" ? doc.content : null;
          if (html !== null) {
            return { stdout: `${html}\n`, stderr: "", exitCode: 0 };
          }
        }
        break;
      }
      case "current": {
        result = await callVektorTool(mcpConfigRef.current, "get_current_document", {});
        if (!json) {
          const doc = (result as Record<string, unknown>)?.document as Record<string, unknown> | undefined;
          const html = typeof doc?.content === "string" ? doc.content : null;
          if (html !== null) {
            return { stdout: `${html}\n`, stderr: "", exitCode: 0 };
          }
        }
        break;
      }
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
      case "delete": {
        const [documentId, ...flags] = rest;
        if (!documentId) {
          return {
            stdout: "",
            stderr: "usage: vektor delete <document-id> [--permanent] [--json]\n",
            exitCode: 2,
          };
        }
        const invalidFlag = flags.find((flag) => flag !== "--permanent");
        if (invalidFlag) {
          return {
            stdout: "",
            stderr: `vektor delete: unknown flag '${invalidFlag}'\n`,
            exitCode: 2,
          };
        }
        const permanent = flags.includes("--permanent");
        result = await callVektorTool(mcpConfigRef.current, "delete_document", {
          documentId,
          permanent,
        });
        if (!json) {
          return {
            stdout: `${permanent ? "deleted" : "archived"} ${documentId}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        break;
      }
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

  const aiCommand = defineCommand("ai", async (args, ctx) => {
    if (!completion) {
      return { stdout: "", stderr: "ai: completion not configured\n", exitCode: 1 };
    }
    const prompt = args.join(" ") || ctx.stdin;
    if (!prompt.trim()) {
      return { stdout: "", stderr: "usage: ai <prompt> or echo <prompt> | ai\n", exitCode: 2 };
    }
    let text: string;
    if (completion.provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": completion.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: completion.model,
          max_tokens: 8192,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
      }
      const data = await response.json() as { content: Array<{ type: string; text?: string }> };
      text = data.content.filter(b => b.type === "text").map(b => b.text ?? "").join("");
    } else {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${completion.apiKey}`,
        },
        body: JSON.stringify({
          model: completion.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
      }
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      text = data.choices[0]?.message?.content ?? "";
    }
    return { stdout: `${text}\n`, stderr: "", exitCode: 0 };
  });

  // Custom curl that uses Node.js fetch directly, bypassing just-bash's loopback/private IP block.
  // Supports: -s (silent), -o <file>, -X <method>, -H <header>, -d <body>, -L (follow redirects).
  const curlCommand = defineCommand("curl", async (args, ctx) => {
    let silent = false;
    let outputFile: string | null = null;
    let method = "GET";
    const headers: Record<string, string> = {};
    let body: string | null = null;
    let url: string | null = null;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "-s" || arg === "--silent") { silent = true; continue; }
      if (arg === "-L" || arg === "--location") { continue; } // fetch follows redirects by default
      if (arg === "-o" || arg === "--output") { outputFile = args[++i] ?? null; continue; }
      if (arg === "-X" || arg === "--request") { method = args[++i] ?? "GET"; continue; }
      if (arg === "-H" || arg === "--header") {
        const raw = args[++i] ?? "";
        const colon = raw.indexOf(":");
        if (colon !== -1) headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
        continue;
      }
      if (arg === "-d" || arg === "--data") { body = args[++i] ?? null; if (method === "GET") method = "POST"; continue; }
      if (!arg.startsWith("-")) { url = arg; continue; }
    }

    if (!url) {
      return { stdout: "", stderr: "curl: no URL specified\nusage: curl [-s] [-o file] [-X method] [-H header] [-d data] <url>\n", exitCode: 2 };
    }

    const response = await fetch(url, {
      method,
      headers,
      ...(body != null ? { body } : {}),
      redirect: "follow",
    });

    const bytes = new Uint8Array(await response.arrayBuffer());

    if (!response.ok && !silent) {
      const text = Buffer.from(bytes).toString("utf-8");
      return { stdout: "", stderr: `curl: HTTP ${response.status}\n${text}\n`, exitCode: 22 };
    }

    if (outputFile) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, outputFile);
      await ctx.fs.writeFile(filePath, bytes, "binary");
      if (!silent) {
        return { stdout: `  % Total\n100  ${bytes.length}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }

    return { stdout: Buffer.from(bytes).toString("utf-8"), stderr: "", exitCode: 0 };
  });

  const extensionCommand = defineCommand("extension", async (args, ctx) => {
    const usage = "usage: extension install <zip-file>\n";
    const [subcommand, fileArg] = args;

    if (subcommand !== "install" || !fileArg) {
      return { stdout: "", stderr: usage, exitCode: 2 };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, fileArg);
    if (!(await ctx.fs.exists(filePath))) {
      return { stdout: "", stderr: `extension: ${fileArg}: No such file or directory\n`, exitCode: 1 };
    }

    const bytes = await ctx.fs.readFileBuffer(filePath);
    const content = Buffer.from(bytes).toString("base64");
    const filename = posix.basename(filePath);

    const result = await callVektorTool(mcpConfigRef.current, "install_extension", {
      filename,
      content,
    });

    return {
      stdout: `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });

  return new Bash({
    cwd: bootstrap?.cwd,
    env: bootstrap?.env,
    customCommands: [zipCommand, zipinfoCommand, unzipCommand, vektorCommand, pandocCommand, uploadCommand, aiCommand, extensionCommand, curlCommand],
  });
}
