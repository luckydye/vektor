import type { APIRoute } from "astro";
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
import {
  deleteAgentSearchUrl,
  getAgentSearchConfigMeta,
  setAgentSearchUrl,
} from "#db/searchConfig.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "editor");

    const meta = await getAgentSearchConfigMeta(spaceId);
    return jsonResponse({ search: meta });
  }, "Failed to get search config");

export const PUT: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");

    const body = await parseJsonBody<{ url?: string }>(context.request);
    if (typeof body.url !== "string" || !body.url.trim()) {
      throw badRequestResponse("url is required");
    }

    const trimmed = body.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw badRequestResponse("url must be a valid absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw badRequestResponse("url must be an http(s) URL");
    }

    await setAgentSearchUrl(spaceId, trimmed);
    const meta = await getAgentSearchConfigMeta(spaceId);
    return jsonResponse({ search: meta });
  }, "Failed to update search config");

export const DELETE: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");

    await deleteAgentSearchUrl(spaceId);
    return successResponse();
  }, "Failed to delete search config");
