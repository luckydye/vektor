import type { APIRoute } from "astro";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  deleteAIChatSession,
  getAIChatSession,
  upsertAIChatSession,
  type AIChatSessionInput,
} from "#db/aiChatSessions.ts";

function parseSessionInput(
  spaceId: string,
  sessionId: string,
  body: unknown,
): AIChatSessionInput {
  if (!body || typeof body !== "object") {
    throw badRequestResponse("Invalid AI chat session payload");
  }

  const session = body as Record<string, unknown>;
  if (session.id !== sessionId) {
    throw badRequestResponse("Session id does not match route");
  }
  if (session.spaceId !== spaceId) {
    throw badRequestResponse("Session spaceId does not match route");
  }
  if (typeof session.title !== "string" || !session.title.trim()) {
    throw badRequestResponse("Session title is required");
  }
  if (
    typeof session.createdAt !== "number" ||
    !Number.isFinite(session.createdAt) ||
    typeof session.updatedAt !== "number" ||
    !Number.isFinite(session.updatedAt)
  ) {
    throw badRequestResponse("Session timestamps must be numbers");
  }
  if (!Array.isArray(session.messages)) {
    throw badRequestResponse("Session messages must be an array");
  }
  if (!Array.isArray(session.conversationHistory)) {
    throw badRequestResponse("Session conversationHistory must be an array");
  }
  if (
    session.shellSnapshot !== undefined &&
    session.shellSnapshot !== null &&
    typeof session.shellSnapshot !== "string"
  ) {
    throw badRequestResponse("Session shellSnapshot must be a string");
  }

  return {
    id: sessionId,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages,
    conversationHistory: session.conversationHistory,
    shellSnapshot:
      session.shellSnapshot === undefined || session.shellSnapshot === null
        ? undefined
        : session.shellSnapshot,
  };
}

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const sessionId = requireParam(context.params, "sessionId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const body = await parseJsonBody(context.request);
    const session = parseSessionInput(spaceId, sessionId, body);
    const saved = await upsertAIChatSession(spaceId, user.id, session);

    return jsonResponse({ session: saved });
  }, "Failed to save AI chat session");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    const sessionId = requireParam(context.params, "sessionId");

    await verifySpaceRole(spaceId, user.id, "viewer");

    const session = await getAIChatSession(spaceId, sessionId, user.id);
    if (!session) {
      throw notFoundResponse("AI chat session");
    }

    await deleteAIChatSession(spaceId, sessionId, user.id);
    return jsonResponse({ success: true });
  }, "Failed to delete AI chat session");
