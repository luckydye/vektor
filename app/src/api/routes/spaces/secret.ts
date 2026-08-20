import { authenticateJobTokenOrSpaceRole, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { requestCredentials } from "#api/acl.ts";
import {
  badRequestResponse,
  forbiddenResponse,
  jsonResponse,
  notFoundResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  deleteSpaceSecret,
  getSpaceSecretMetadata,
  getSpaceSecretValueForUser,
  hasSpaceSecret,
  sanitizeSecretName,
  upsertSpaceSecret,
} from "#db/space/spaceSecrets.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const name = requireParam(context.var.params, "name");
    const auth = await authenticateJobTokenOrSpaceRole(
      requestCredentials(context),
      spaceId,
      Permission.OWNER,
    );
    const userId = auth.type === "user" ? auth.user.id : auth.userId;

    if (!userId) {
      throw forbiddenResponse("Job is not associated with a user");
    }

    const store = await openSpaceStore(spaceId);
    const value = await getSpaceSecretValueForUser(store, name, userId);
    if (value === null) {
      if (await hasSpaceSecret(store, name)) {
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
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );

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

    const store = await openSpaceStore(spaceId);
    const secret = await upsertSpaceSecret(
      store,
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
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );

    const store = await openSpaceStore(spaceId);
    const deleted = await deleteSpaceSecret(store, name);
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
    await verifyAccess(
      spaceId,
      { type: ResourceType.SPACE, id: spaceId },
      user.id,
      Permission.OWNER,
    );

    const store = await openSpaceStore(spaceId);
    const secret = await getSpaceSecretMetadata(store, name);
    if (!secret) {
      throw notFoundResponse("Secret");
    }

    return new Response(null, { status: 200 });
  }, "Failed to check secret");
