import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  parseJsonBody,
  requireUser,
  unauthorizedResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  createJobToken,
  parseJobToken,
  verifyJobToken,
} from "../../../../jobs/jobToken.ts";
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

type AcpRequestBody = {
  messages?: ChatMessage[];
  stream?: boolean;
  spaceId?: string;
  documentId?: string;
};

function getRepoRoot(): string {
  return fileURLToPath(new URL("../../../../../../", import.meta.url));
}

function getApiOrigin(request: Request): string {
  const configured = config().API_URL;
  if (configured) {
    return new URL(configured, request.url).origin;
  }
  return new URL(request.url).origin;
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
  apiUrl: string;
  spaceId: string;
  documentId?: string;
  jobToken: string;
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
      const acpCommand = config().ACP_COMMAND;
      if (!acpCommand) {
        throw new Error("WIKI_ACP_COMMAND not configured");
      }

      const body = await parseJsonBody<AcpRequestBody>(context.request);

      if (!Array.isArray(body.messages)) {
        return badRequestResponse("messages is required");
      }
      if (!body.spaceId || typeof body.spaceId !== "string") {
        return badRequestResponse("spaceId is required");
      }
      if (body.documentId !== undefined && typeof body.documentId !== "string") {
        return badRequestResponse("documentId must be a string");
      }

      let jobToken: string;
      if (!context.locals.user) {
        const providedJobToken = context.request.headers.get("X-Job-Token");
        const headerSpaceId = context.request.headers.get("X-Space-Id");
        if (
          !providedJobToken ||
          !headerSpaceId ||
          !verifyJobToken(providedJobToken, headerSpaceId)
        ) {
          throw unauthorizedResponse();
        }
        if (headerSpaceId !== body.spaceId) {
          return badRequestResponse("spaceId does not match job token scope");
        }
        const parsed = parseJobToken(providedJobToken, body.spaceId);
        if (!parsed) {
          throw unauthorizedResponse();
        }
        jobToken = providedJobToken;
      } else {
        const user = requireUser(context);
        await verifySpaceRole(body.spaceId, user.id, "viewer");
        jobToken = createJobToken(body.spaceId, Date.now().toString(), user.id);
      }

      const prompt = buildPrompt(body.messages);
      if (body.stream) {
        return createStreamingResponse({
          command: acpCommand,
          cwd: getRepoRoot(),
          prompt,
          apiUrl: getApiOrigin(context.request),
          spaceId: body.spaceId,
          documentId: body.documentId,
          jobToken,
          signal: context.request.signal,
        });
      }

      const result = await runAcpPrompt({
        command: acpCommand,
        cwd: getRepoRoot(),
        prompt,
        apiUrl: getApiOrigin(context.request),
        spaceId: body.spaceId,
        documentId: body.documentId,
        jobToken,
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
