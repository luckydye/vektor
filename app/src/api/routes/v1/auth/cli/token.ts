/**
 * POST /api/v1/auth/cli/token
 *
 * Exchanges the one-time code produced by POST /api/v1/auth/cli for a real
 * access token. No session cookie required — the code itself is the proof of
 * authentication. Single-use; expires 60 seconds after issuance.
 *
 * Body:  { code: string }
 * Returns: { token: string, spaceId: string }
 */

import type { APIRoute } from "astro";
import { pendingCliCodes } from "#api/routes/v1/auth/cli.ts";
import { createAccessToken, grantTokenAccess } from "#db/accessTokens.ts";
import { ResourceType } from "#db/acl.ts";
import { badRequestResponse, parseJsonBody, withApiErrorHandling } from "#db/api.ts";

export const POST: APIRoute = (context) =>
  withApiErrorHandling(async () => {
    const body = await parseJsonBody(context.request);
    const { code } = body;

    if (!code || typeof code !== "string") {
      throw badRequestResponse("code is required");
    }

    const entry = pendingCliCodes.get(code);
    if (!entry) {
      throw badRequestResponse("Invalid or expired code");
    }
    if (Date.now() > entry.expiresAt) {
      pendingCliCodes.delete(code);
      throw badRequestResponse("Code has expired");
    }

    // Single-use — delete immediately.
    pendingCliCodes.delete(code);

    const { userId, spaceId } = entry;

    const result = await createAccessToken({
      spaceId,
      name: `CLI (${new Date().toISOString().slice(0, 10)})`,
      createdBy: userId,
      // No expiry — user can revoke from the UI if needed.
    });

    await grantTokenAccess({
      tokenId: result.id,
      spaceId,
      resourceType: ResourceType.SPACE,
      resourceId: spaceId,
      permission: "editor",
    });

    return Response.json({ token: result.token, spaceId });
  }, "Token exchange failed");
