import type { APIRoute } from "astro";
import {
  deleteAIConfig,
  getAIConfigMeta,
  setAIConfig,
} from "#db/aiConfig.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "editor");

    const meta = await getAIConfigMeta(spaceId);
    return jsonResponse({ aiProvider: meta });
  }, "Failed to get AI provider config");

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");

    const body = await parseJsonBody<{
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
    }>(context.request);

    if (typeof body.provider !== "string") {
      throw badRequestResponse("provider is required");
    }
    if (typeof body.model !== "string" || !body.model.trim()) {
      throw badRequestResponse("model is required");
    }

    const provider = body.provider;
    const model = body.model.trim();

    if (provider === "ollama") {
      if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
        throw badRequestResponse("baseUrl is required for ollama provider");
      }
      await setAIConfig(spaceId, { provider: "ollama", model, baseUrl: body.baseUrl.trim().replace(/\/$/, "") }, user.id);
    } else if (provider === "anthropic" || provider === "openrouter") {
      if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
        throw badRequestResponse("apiKey is required for anthropic and openrouter providers");
      }
      await setAIConfig(spaceId, { provider, model, apiKey: body.apiKey.trim() }, user.id);
    } else {
      throw badRequestResponse(`Unknown provider "${provider}". Valid values: anthropic, openrouter, ollama`);
    }

    const meta = await getAIConfigMeta(spaceId);
    return jsonResponse({ aiProvider: meta });
  }, "Failed to update AI provider config");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");

    await deleteAIConfig(spaceId);
    return successResponse();
  }, "Failed to delete AI provider config");
