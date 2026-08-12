import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import { ollamaChatUrl, resolveProviderUrl } from "#api/provider/ollama.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { deleteAIConfig, getAIConfigMeta, setAIConfig } from "#db/space/aiConfig.ts";
import { SsrfError } from "#utils/ssrf.ts";

/**
 * Normalize a configured Ollama base URL, refusing one the server must not call.
 *
 * The stored value becomes a server-side request triggered by any viewer, with
 * the upstream body returned in the completion, so "non-empty string" was the
 * whole of the check and `http://169.254.169.254` was a valid answer. The 400
 * here is the door; {@link resolveProviderUrl} at fetch time is the lock, because
 * a stored value can predate this check and DNS can move afterwards.
 */
export async function normalizeOllamaBaseUrl(rawBaseUrl: unknown): Promise<string> {
  if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) {
    throw badRequestResponse("baseUrl is required for ollama provider");
  }
  const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
  try {
    // Validate the URL that will actually be requested, not just the base.
    await resolveProviderUrl(ollamaChatUrl(baseUrl));
  } catch (error) {
    throw badRequestResponse(
      error instanceof SsrfError
        ? `baseUrl is not allowed: ${error.message}`
        : "baseUrl is not a valid URL",
    );
  }
  return baseUrl;
}

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.EDITOR);

    const store = await openSpaceStore(spaceId);
    const meta = await getAIConfigMeta(store);
    return jsonResponse({ aiProvider: meta });
  }, "Failed to get AI provider config");

export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.OWNER);

    const body = await parseJsonBody<{
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
    }>(context.req.raw);

    if (typeof body.provider !== "string") {
      throw badRequestResponse("provider is required");
    }
    if (typeof body.model !== "string" || !body.model.trim()) {
      throw badRequestResponse("model is required");
    }

    const provider = body.provider;
    const model = body.model.trim();

    const store = await openSpaceStore(spaceId);
    if (provider === "ollama") {
      const baseUrl = await normalizeOllamaBaseUrl(body.baseUrl);
      await setAIConfig(store, { provider: "ollama", model, baseUrl }, user.id);
    } else if (
      provider === "anthropic" ||
      provider === "openai" ||
      provider === "openrouter" ||
      provider === "opencode-zen"
    ) {
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        throw badRequestResponse(
          "apiKey is required for anthropic, openai, openrouter and opencode-zen providers",
        );
      }
      await setAIConfig(store, { provider, model, apiKey: body.apiKey.trim() }, user.id);
    } else {
      throw badRequestResponse(
        `Unknown provider "${provider}". Valid values: anthropic, openai, openrouter, opencode-zen, ollama`,
      );
    }

    const meta = await getAIConfigMeta(store);
    return jsonResponse({ aiProvider: meta });
  }, "Failed to update AI provider config");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.OWNER);

    const store = await openSpaceStore(spaceId);
    await deleteAIConfig(store);
    return successResponse();
  }, "Failed to delete AI provider config");
