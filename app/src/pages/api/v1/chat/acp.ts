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

      if (body.stream) {
        return badRequestResponse("ACP streaming is not implemented");
      }
      if (!Array.isArray(body.messages)) {
        return badRequestResponse("messages is required");
      }

      const prompt = buildPrompt(body.messages);
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
      onError: () => errorResponse("ACP request failed", 500),
    },
  );
