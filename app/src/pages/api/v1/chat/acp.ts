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
import { runAgentInWorker } from "../../../../agent/agent.ts";

type ChatRole = "system" | "user" | "assistant" | "tool";

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
  chatId?: string;
  spaceId?: string;
  documentId?: string;
};

function getApiOrigin(request: Request): string {
  const configured = config().API_URL;
  if (configured) {
    return new URL(configured, request.url).origin;
  }
  return new URL(request.url).origin;
}

function normalizeMessages(
  messages: ChatMessage[],
): Array<{ role: ChatRole; content: string | null }> {
  return messages.map((m) => ({
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join(""),
  }));
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
  if (options.role) delta.role = options.role;
  if (options.content) delta.content = options.content;

  const payload: Record<string, unknown> = {
    id: options.id,
    object: "chat.completion.chunk",
    created: options.created,
    model: "bash-agent",
    choices: [{ index: 0, delta, finish_reason: options.finishReason ?? null }],
  };

  if (options.stopReason) {
    payload.acp = { stopReason: options.stopReason };
  }

  return payload;
}

function createStreamingResponse(options: {
  messages: Array<{ role: ChatRole; content: string | null }>;
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
          send(createChunkPayload({ id, created, role: "assistant" }));

          const result = await runAgentInWorker({
            ...options,
            onChunk: (content) => {
              send(createChunkPayload({ id, created, content }));
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
          send({ error: error instanceof Error ? error.message : "Agent request failed" });
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
      const body = await parseJsonBody<AcpRequestBody>(context.request);

      if (!Array.isArray(body.messages)) {
        return badRequestResponse("messages is required");
      }
      if (!body.chatId || typeof body.chatId !== "string") {
        return badRequestResponse("chatId is required");
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

      const messages = normalizeMessages(body.messages);
      const sharedOptions = {
        messages,
        apiUrl: getApiOrigin(context.request),
        spaceId: body.spaceId,
        documentId: body.documentId,
        jobToken,
        signal: context.request.signal,
      };

      if (body.stream) {
        return createStreamingResponse(sharedOptions);
      }

      const result = await runAgentInWorker(sharedOptions);
      return Response.json({
        id: `chatcmpl_${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "bash-agent",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.content },
            finish_reason: "stop",
          },
        ],
        acp: { stopReason: result.stopReason },
      });
    },
    {
      fallbackMessage: "Agent request failed",
      onError: (error) =>
        errorResponse(error instanceof Error ? error.message : "Agent request failed", 500),
    },
  );
