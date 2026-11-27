import { requireChatSession } from "#acl/guards.ts";
import {
  badRequestResponse,
  jsonResponse,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { listVisibleChatMessages } from "#db/space/chatSessions.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function intParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw badRequestResponse(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Page through a chat session's messages, newest page first: `?before=<seq>&limit=<n>`
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const sessionId = requireParam(context.var.params, "sessionId");
    await requireChatSession(platform, credentials, spaceId, sessionId, "read");

    const url = new URL(context.req.url);
    const limit = Math.min(intParam(url, "limit") ?? DEFAULT_LIMIT, MAX_LIMIT);
    const messages = await listVisibleChatMessages(
      await openSpaceStore(platform, spaceId),
      sessionId,
      { beforeSeq: intParam(url, "before"), limit },
    );
    return jsonResponse({
      // Inline images are the model's; the UI shows the uploads they came from.
      messages: messages.map(({ metadata: { images: _images, ...metadata }, ...row }) => ({
        ...row,
        metadata,
      })),
      hasMore: messages.length === limit,
    });
  }, "Failed to list chat messages");
