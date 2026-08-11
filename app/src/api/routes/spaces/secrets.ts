import { verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  listSpaceSecrets,
  sanitizeSecretName,
  upsertSpaceSecret,
} from "#db/spaceSecrets.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.EDITOR);

    const secrets = await listSpaceSecrets(spaceId);
    return jsonResponse({ secrets });
  }, "Failed to list secrets");

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.var.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, Permission.OWNER);

    const body = await parseJsonBody<{
      name?: string;
      value?: string;
      description?: string | null;
    }>(context.req.raw);

    if (typeof body.name !== "string") {
      throw badRequestResponse("name is required");
    }
    if (typeof body.value !== "string") {
      throw badRequestResponse("value is required");
    }

    let name: string;
    try {
      name = sanitizeSecretName(body.name);
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
      name,
      body.value,
      user.id,
      description,
    );
    return createdResponse({ secret });
  }, "Failed to save secret");
