import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  deleteSpaceSecret,
  getSpaceSecretMetadata,
  getSpaceSecretValueForUser,
  hasSpaceSecret,
  sanitizeSecretName,
  upsertSpaceSecret,
} from "#db/spaceSecrets.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const name = requireParam(context.var.params, "name");
    const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");
    const userId = auth.type === "user" ? auth.user.id : auth.userId;

    if (!userId) {
      throw forbiddenResponse("Job is not associated with a user");
    }

    const value = await getSpaceSecretValueForUser(spaceId, name, userId);
    if (value === null) {
      if (await hasSpaceSecret(spaceId, name)) {
        throw forbiddenResponse("Secret access denied");
      }
      throw notFoundResponse("Secret");
    }

    return jsonResponse({ name, value });
  }, "Failed to get secret");

export const PUT: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const name = requireParam(context.var.params, "name");
    await verifySpaceRole(spaceId, user.id, "owner");

    const body = await parseJsonBody<{
      value?: string;
      description?: string | null;
    }>(context.req.raw);

    if (typeof body.value !== "string") {
      throw badRequestResponse("value is required");
    }

    let normalized: string;
    try {
      normalized = sanitizeSecretName(name);
    } catch (error) {
      throw badRequestResponse(
        error instanceof Error ? error.message : "Invalid secret name",
      );
    }
    const description =
      body.description === undefined || body.description === null
        ? null
        : String(body.description).trim();

    const secret = await upsertSpaceSecret(
      spaceId,
      normalized,
      body.value,
      user.id,
      description,
    );

    return jsonResponse({ secret });
  }, "Failed to update secret");

export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const name = requireParam(context.var.params, "name");
    await verifySpaceRole(spaceId, user.id, "owner");

    const deleted = await deleteSpaceSecret(spaceId, name);
    if (!deleted) {
      throw notFoundResponse("Secret");
    }

    return successResponse();
  }, "Failed to delete secret");

export const HEAD: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    const name = requireParam(context.var.params, "name");
    await verifySpaceRole(spaceId, user.id, "editor");

    const secret = await getSpaceSecretMetadata(spaceId, name);
    if (!secret) {
      throw notFoundResponse("Secret");
    }

    return new Response(null, { status: 200 });
  }, "Failed to check secret");
