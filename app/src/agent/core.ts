import { Bash } from "just-bash";
import { config, getConfiguredOpenRouterModel } from "../config.ts";
import { listTools as listVektorTools, callTool as callVektorTool } from "../utils/vektorMcp.ts";
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
};

export type AgentEvent =
  | { type: "text"; text: string }
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
The bash tool runs inside just-bash, not full system shell.
- Do not assume node, npm, npx, pnpm, bun, pip, python, or js-exec exist.
- Prefer direct shell utilities already available in just-bash.
- If command fails, inspect error output and adapt. Do not assume missing commands exist on retry.`;

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
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void | Promise<void>;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}): Promise<AgentResult> {
  const {
    messages,
    spaceId,
    documentId,
    jobToken,
    apiUrl,
    signal,
    onChunk,
    onEvent,
  } = options;

  const apiKey = config().OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
  const model = getConfiguredOpenRouterModel();

  const mcpConfig: VektorMcpConfig = { apiUrl, spaceId, jobToken, documentId };
  const bash = new Bash();

  const vektorTools = await listVektorTools(mcpConfig);
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
    { role: "system", content: CORE_AGENT_SYSTEM_PROMPT },
    ...messages,
  ];
  const allChunks: string[] = [];

  while (true) {
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
          result = await callVektorTool(mcpConfig, toolCall.function.name, args);
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

      agentMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content,
      });
    }
  }
}
