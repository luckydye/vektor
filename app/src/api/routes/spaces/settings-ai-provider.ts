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
import type { ApiRouteHandler } from "#api/server/types.ts";
import { deleteAIConfig, getAIConfigMeta, setAIConfig } from "#db/aiConfig.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.EDITOR);

    const meta = await getAIConfigMeta(spaceId);
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

    if (provider === "ollama") {
      if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
        throw badRequestResponse("baseUrl is required for ollama provider");
      }
      await setAIConfig(
        spaceId,
        { provider: "ollama", model, baseUrl: body.baseUrl.trim().replace(/\/$/, "") },
        user.id,
      );
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
      await setAIConfig(
        spaceId,
        { provider, model, apiKey: body.apiKey.trim() },
        user.id,
      );
    } else {
      throw badRequestResponse(
        `Unknown provider "${provider}". Valid values: anthropic, openai, openrouter, opencode-zen, ollama`,
      );
    }

    const meta = await getAIConfigMeta(spaceId);
    return jsonResponse({ aiProvider: meta });
  }, "Failed to update AI provider config");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.OWNER);

    await deleteAIConfig(spaceId);
    return successResponse();
  }, "Failed to delete AI provider config");
