import { authenticateChatCaller, requireChatSession } from "#acl/guards.ts";
import { withRunning } from "#agent/chatTurns.ts";
import { jsonResponse, requireParam, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  listChannels,
  listThreads,
  toChatSessionSummary,
} from "#db/space/chatSessions.ts";
import { agentRunners } from "#runners/runners.ts";

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
