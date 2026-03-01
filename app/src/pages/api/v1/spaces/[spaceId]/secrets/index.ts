import type { APIRoute } from "astro";
import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  requireUser,
  verifySpaceRole,
  withApiErrorHandling,
} from "#db/api.ts";
import {
  listSpaceSecrets,
  sanitizeSecretName,
  upsertSpaceSecret,
} from "#db/spaceSecrets.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");

    const secrets = await listSpaceSecrets(spaceId);
    return jsonResponse({ secrets });
  }, "Failed to list secrets");

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const spaceId = requireParam(context.params, "spaceId");
    await verifySpaceRole(spaceId, user.id, "owner");

    const body = await parseJsonBody<{
      name?: string;
      value?: string;
      description?: string | null;
    }>(context.request);

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
