import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  type AIChatSessionInput,
  deleteAIChatSession,
  getAIChatSession,
  upsertAIChatSession,
} from "#db/space/aiChatSessions.ts";

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

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const session = await getAIChatSession(store, sessionId, user.id);
    if (!session) {
      throw notFoundResponse("AI chat session");
    }

    return jsonResponse({ session });
  }, "Failed to get AI chat session");

export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const body = await parseJsonBody(context.req.raw);
    const session = parseSessionInput(spaceId, sessionId, body);
    const store = await openSpaceStore(spaceId);
    const saved = await upsertAIChatSession(store, user.id, session);

    return jsonResponse({ session: saved });
  }, "Failed to save AI chat session");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");

    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.VIEWER,
    );

    const store = await openSpaceStore(spaceId);
    const session = await getAIChatSession(store, sessionId, user.id);
    if (!session) {
      throw notFoundResponse("AI chat session");
    }

    await deleteAIChatSession(store, sessionId, user.id);
    return jsonResponse({ success: true });
  }, "Failed to delete AI chat session");
