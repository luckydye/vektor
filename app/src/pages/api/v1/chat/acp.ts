import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  parseJsonBody,
  unauthorizedResponse,
  withApiErrorHandling,
} from "#db/api.ts";
import { verifyJobToken } from "../../../../jobs/jobToken.ts";
import { config } from "../../../../config.ts";
import { runAcpPrompt } from "../../../../utils/acp.ts";
import { fileURLToPath } from "node:url";

type ChatRole = "system" | "user" | "assistant";

type ChatContentPart = {
  type: string;
  text?: string;
};

type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentPart[];
};

function getRepoRoot(): string {
  return fileURLToPath(new URL("../../../../../../", import.meta.url));
}

function extractMessageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  const parts: string[] = [];
  for (const part of content) {
    if (part.type !== "text" || typeof part.text !== "string") {
      throw badRequestResponse("Only text message content is supported");
    }
    parts.push(part.text);
  }
  return parts.join("");
}

function buildPrompt(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    throw badRequestResponse("messages must not be empty");
  }

  const transcript = messages
    .map((message) => {
      if (
        message.role !== "system" &&
        message.role !== "user" &&
        message.role !== "assistant"
      ) {
        throw badRequestResponse(`Unsupported message role: ${String(message.role)}`);
      }
      const content = extractMessageText(message.content).trim();
      if (!content) {
        throw badRequestResponse("messages must contain non-empty text content");
      }
      return `${message.role.toUpperCase()}:\n${content}`;
    })
    .join("\n\n");

  return `${transcript}\n\nReply as ASSISTANT to the latest USER message.`;
}

function createCompletionResponse(content: string, stopReason: string): Response {
  return Response.json({
    id: `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "acp-configured-agent",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    acp: {
      stopReason,
    },
  });
}

function createChunkPayload(options: {
  id: string;
  created: number;
  content?: string;
  finishReason?: string | null;
  stopReason?: string;
  role?: "assistant";
}): Record<string, unknown> {
  const delta: Record<string, string> = {};
  if (options.role) {
    delta.role = options.role;
  }
  if (options.content) {
    delta.content = options.content;
  }

  const payload: Record<string, unknown> = {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: "acp-configured-agent",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: options.finishReason ?? null,
      },
    ],
  };

  if (options.stopReason) {
    payload.acp = {
      stopReason: options.stopReason,
    };
  }

  return payload;
}

function createStreamingResponse(options: {
  command: string;
  cwd: string;
  prompt: string;
  signal?: AbortSignal;
}): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (payload: Record<string, unknown> | "[DONE]") => {
          const data =
            payload === "[DONE]"
              ? "data: [DONE]\n\n"
              : `data: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(encoder.encode(data));
        };

        try {
          send(
            createChunkPayload({
              id,
              created,
              role: "assistant",
            }),
          );

          const result = await runAcpPrompt({
            ...options,
            onChunk: (content) => {
              send(
                createChunkPayload({
                  id,
                  created,
                  content,
                }),
              );
            },
          });

          send(
            createChunkPayload({
              id,
              created,
              finishReason: "stop",
              stopReason: result.stopReason,
            }),
          );
          send("[DONE]");
        } catch (error) {
          send({
            error: error instanceof Error ? error.message : "ACP request failed",
          });
          send("[DONE]");
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}

export const POST: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      if (!context.locals.user) {
        const jobToken = context.request.headers.get("X-Job-Token");
        const spaceId = context.request.headers.get("X-Space-Id");
        if (!jobToken || !spaceId || !verifyJobToken(jobToken, spaceId)) {
          throw unauthorizedResponse();
        }
      }

      const acpCommand = config().ACP_COMMAND;
      if (!acpCommand) {
        throw new Error("WIKI_ACP_COMMAND not configured");
      }

      const body = await parseJsonBody<{
        messages?: ChatMessage[];
        stream?: boolean;
      }>(context.request);

      if (!Array.isArray(body.messages)) {
        return badRequestResponse("messages is required");
      }

      const prompt = buildPrompt(body.messages);
      if (body.stream) {
        return createStreamingResponse({
          command: acpCommand,
          cwd: getRepoRoot(),
          prompt,
          signal: context.request.signal,
        });
      }

      const result = await runAcpPrompt({
        command: acpCommand,
        cwd: getRepoRoot(),
        prompt,
        signal: context.request.signal,
      });

      return createCompletionResponse(result.content, result.stopReason);
    },
    {
      fallbackMessage: "ACP request failed",
      onError: (error) =>
        errorResponse(error instanceof Error ? error.message : "ACP request failed", 500),
    },
  );
