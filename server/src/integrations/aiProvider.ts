import { buildIntegrationApiUrl } from "#api/routes/spaces/integration-proxy.ts";
import type { AIProvider } from "#api/provider/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getAIProvider } from "#db/space/aiConfig.ts";
import {
  getOAuthIntegrationCredentialForUser,
  listOAuthIntegrationsForUser,
} from "#db/space/oauthIntegrations.ts";
import {
  getOAuthProviderConfiguration,
  resolveIntegrationAccessToken,
} from "#integrations/oauthProviders.ts";

/**
 * The provider a user's agent chats run on: the integration they picked a
 * model on, or the instance's provider when they picked none.
 */
export async function resolveUserAIProvider(
  spaceId: string,
  userId: string,
): Promise<AIProvider> {
  const store = await openSpaceStore(spaceId);
  const connections = await listOAuthIntegrationsForUser(store, userId);
  const selected = connections.find((connection) => connection.aiModel);
  if (!selected?.aiModel) return getAIProvider();

  const resolved = await getOAuthProviderConfiguration(spaceId, selected.provider);
  if (!resolved?.configured || !resolved.config.ai) {
    throw new Error(
      `${selected.provider} no longer provides AI models. Pick another model under Integrations.`,
    );
  }
  const providerConfig = resolved.config;

  return {
    provider: "integration",
    integration: selected.provider,
    format: providerConfig.ai.format,
    url: buildIntegrationApiUrl(providerConfig, providerConfig.ai.path).href,
    // Read fresh on every call: a refresh replaces the stored tokens, and a
    // turn can outlast the access token it started with.
    accessToken: async () => {
      const credential = await getOAuthIntegrationCredentialForUser(
        store,
        userId,
        selected.provider,
      );
      if (!credential) throw new Error(`${selected.provider} is not connected`);
      return resolveIntegrationAccessToken(spaceId, credential, providerConfig);
    },
    model: selected.aiModel,
  };
}
