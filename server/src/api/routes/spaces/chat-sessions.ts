import {
  authenticateChatCaller,
  authenticateJobTokenOrSpaceRole,
  type CallerCredentials,
  requireChatSession,
} from "#acl/guards.ts";
import { Permission, channelOfBotPrincipal } from "#acl/permissions.ts";
import { postChatMessage, withRunning } from "#agent/chatTurns.ts";
import {
  badRequestResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import {
  countManagedBots,
  createChatSession,
  getChatSession,
  listChannels,
  listThreads,
  type StoredChatSession,
  toChatSessionSummary,
} from "#db/space/chatSessions.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { sendSyncEvent } from "#realtime/events.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { agentRunners } from "#runners/runners.ts";

const MAX_MANAGED_BOTS = 12;
const MAX_NAME_CHARS = 60;
const MAX_TEXT_CHARS = 20_000;

/**
 * List the space's bot channels with their thread counts, or with `?parent=` a channel's threads
 *
 * @tag AI
 * @jobToken
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const parent = new URL(context.req.url).searchParams.get("parent");
    const store = await openSpaceStore(platform, spaceId);

    if (parent) {
      await requireChatSession(platform, credentials, spaceId, parent, "read");
      const threads = await listThreads(store, parent);
      return jsonResponse({
        sessions: threads.map((thread) => ({
          ...withRunning(toChatSessionSummary(thread)),
          messageCount: thread.messageCount,
        })),
      });
    }

    await authenticateChatCaller(platform, credentials, spaceId);
    const channels = await listChannels(store);
    // A bot on a node runs on its owner's runners, so whether it can answer is theirs to say.
    const runnersOf = new Map<string, Promise<string[]>>();
    const nodesOf = (owner: string) => {
      let names = runnersOf.get(owner);
      if (!names) {
        names = agentRunners(platform, { spaceId, userId: owner }).then((runners) =>
          runners.map((runner) => runner.name),
        );
        runnersOf.set(owner, names);
      }
      return names;
    };
    return jsonResponse({
      sessions: await Promise.all(
        channels.map(async (channel) => ({
          ...withRunning(toChatSessionSummary(channel)),
          threadCount: channel.threadCount,
          ...(channel.node
            ? { nodeOnline: (await nodesOf(channel.createdBy)).includes(channel.node) }
            : {}),
        })),
      ),
    });
  }, "Failed to list chat sessions");

/** The bot channel behind the caller, which must be an editor of the space. */
async function requireBotParent(
  platform: Platform,
  credentials: CallerCredentials,
  spaceId: string,
): Promise<{
  store: SpaceStore;
  parent: StoredChatSession;
  principal: string;
  jobToken: string;
}> {
  const auth = await authenticateJobTokenOrSpaceRole(
    platform,
    credentials,
    spaceId,
    Permission.EDITOR,
  );
  const principal = auth.type === "user" ? auth.user.id : auth.userId;
  if (!principal || !credentials.jobToken) {
    throw badRequestResponse("Only a bot can manage bots");
  }
  const jobToken = credentials.jobToken;
  const parentId = channelOfBotPrincipal(principal);
  if (!parentId) throw badRequestResponse("Only a bot can manage bots");

  const store = await openSpaceStore(platform, spaceId);
  const parent = await getChatSession(store, parentId);
  if (!parent || parent.visibility !== "space" || parent.parentSessionId) {
    throw notFoundResponse("Bot");
  }
  return { store, parent, principal, jobToken };
}

function optionalText(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequestResponse(`${name} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > MAX_TEXT_CHARS) {
    throw badRequestResponse(`${name} must be at most ${MAX_TEXT_CHARS} characters`);
  }
  return text;
}

/**
 * Spawn a bot managed by the calling bot
 *
 * @tag AI
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const { platform, credentials } = context.var;
    const spaceId = requireParam(context.var.params, "spaceId");
    const { store, parent, principal, jobToken } = await requireBotParent(
      platform,
      credentials,
      spaceId,
    );

    if ((await countManagedBots(store, parent.id)) >= MAX_MANAGED_BOTS) {
      throw badRequestResponse(
        `This bot already manages ${MAX_MANAGED_BOTS} bots; remove one first.`,
      );
    }

    const body = await parseJsonBody<Record<string, unknown>>(context.req.raw);
    const name = optionalText(body, "name");
    if (!name) throw badRequestResponse("name is required");
    if (name.length > MAX_NAME_CHARS) {
      throw badRequestResponse(`name must be at most ${MAX_NAME_CHARS} characters`);
    }
    const rolePrompt = optionalText(body, "rolePrompt");
    const task = optionalText(body, "task");

    const bot = await createChatSession(store, {
      title: name,
      createdBy: parent.createdBy,
      source: parent.source,
      visibility: "space",
      access: parent.node ? "editor" : parent.access,
      rolePrompt: rolePrompt ?? null,
      avatar: null,
      node: parent.node,
      nodeAgent: parent.nodeAgent,
      managedBy: parent.id,
      parentSessionId: null,
      threadRootSeq: null,
    });
    sendSyncEvent(spaceId, {
      topic: realtimeTopics.chat,
      data: { sessionId: bot.id, parentSessionId: null, state: "created" },
    });

    if (task) {
      const { round } = await postChatMessage(
        platform,
        bot,
        {
          authorId: principal,
          text: task,
          attachments: [],
          imageAttachments: [],
          fromBot: parent.id,
        },
        jobToken,
      );
      round.catch((error) =>
        appLogger.error("Managed bot task failed", {
          spaceId,
          sessionId: bot.id,
          error,
        }),
      );
    }

    return jsonResponse({ bot: toChatSessionSummary(bot) });
  }, "Failed to spawn bot");
