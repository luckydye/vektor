/**
 * POST /api/v1/auth/cli/token
 *
 * Exchanges the one-time code produced by POST /api/v1/auth/cli for a real
 * access token. No session cookie required — the code itself is the proof of
 * authentication. Single-use; expires 60 seconds after issuance.
 *
 * The token delegates the approving user's own access: it carries the role that
 * user holds on the space, resolved at exchange rather than at approval so a
 * role revoked in between is honoured.
 *
 * Body:  { code: string }
 * Returns: { token: string, spaceId: string, permission: string, expiresAt: string }
 */

import { CliTokenError, mintCliToken } from "#api/cliAuth.ts";
import {
  badRequestResponse,
  errorResponse,
  parseJsonBody,
  withApiErrorHandling,
} from "#api/http.ts";
import { pendingCliCodes } from "#api/routes/auth/cli.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody(context.req.raw);
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

      return Response.json(
        await mintCliToken({ userId: entry.userId, spaceId: entry.spaceId }),
      );
    },
    {
      fallbackMessage: "Token exchange failed",
      onError: (error) =>
        error instanceof CliTokenError
          ? errorResponse(error.message, error.status)
          : undefined,
    },
  );
