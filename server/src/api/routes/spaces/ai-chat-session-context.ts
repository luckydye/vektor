import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { prepareAgentTurn } from "#agent/core.ts";
import {
  jsonResponse,
  notFoundResponse,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { getLocalOrigin } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { getAIChatSession } from "#db/space/aiChatSessions.ts";
import { listOAuthIntegrationsForUser } from "#db/space/oauthIntegrations.ts";
import { getUserProfile } from "#db/space/userProfiles.ts";
import { resolveUserAIProvider } from "#integrations/aiProvider.ts";
import { createJobToken } from "#jobs/jobToken.ts";

/**
 * Read the model context the session's next turn would send: model, tools, system prompt and the conversation history
 *
 * @tag AI
 * @query documentId The document open in the chat, which the system prompt describes.
 */
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

    const [userProfile, integrations, provider] = await Promise.all([
      getUserProfile(store, user.id),
      listOAuthIntegrationsForUser(store, user.id),
      resolveUserAIProvider(spaceId, user.id),
    ]);
    const { systemPrompt, tools } = await prepareAgentTurn({
      apiUrl: getLocalOrigin(),
      spaceId,
      documentId: new URL(context.req.url).searchParams.get("documentId") ?? undefined,
      connectedProviders: integrations.map((integration) => integration.provider),
      userProfile: userProfile ?? undefined,
      jobToken: createJobToken(spaceId, Date.now().toString(), user.id),
    });

    return jsonResponse({
      model: provider.model,
      tools,
      messages: [
        { role: "system", content: systemPrompt },
        ...session.conversationHistory,
      ],
    });
  }, "Failed to get AI chat session context");
