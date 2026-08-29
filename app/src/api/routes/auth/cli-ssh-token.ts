/**
 * POST /api/v1/auth/cli/ssh/token
 *
 * The headless half of `vektor login`: proves who is asking with an SSH
 * signature instead of a browser session, then mints the same token the browser
 * flow does. Nothing here is authenticated by the transport — the signature is
 * the credential, and it is only accepted over a challenge this server issued
 * moments ago and immediately spends.
 *
 * Body:
 *   challenge  the nonce from POST /api/v1/auth/cli/ssh/challenge
 *   signature  armored SSHSIG over that nonce, namespace "vektor-cli"
 *   spaceId    optional; required only when the user holds a role on several spaces
 *
 * Returns: { token, spaceId, permission, expiresAt }
 */

import { CliTokenError, listCliTokenSpaces, mintCliToken } from "#api/cliAuth.ts";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  parseJsonBody,
  withApiErrorHandling,
} from "#api/http.ts";
import { consumeSshChallenge } from "#api/routes/auth/cli-ssh.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { findSshKeyByFingerprint, markSshKeyUsed } from "#db/auth/sshKeys.ts";
import { appLogger } from "#observability/logger.ts";
import { SshKeyError, verifySshSignature } from "#utils/sshKeys.ts";

export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const body = await parseJsonBody(context.req.raw);
      const { challenge, signature, spaceId } = body;

      if (typeof challenge !== "string" || typeof signature !== "string") {
        throw badRequestResponse("challenge and signature are required");
      }
      if (spaceId !== undefined && spaceId !== null && typeof spaceId !== "string") {
        throw badRequestResponse("spaceId must be a string");
      }

      // Spent before the signature is looked at: a challenge gets one attempt,
      // successful or not.
      if (!consumeSshChallenge(challenge)) {
        throw badRequestResponse("Invalid or expired challenge");
      }

      let verified: ReturnType<typeof verifySshSignature>;
      try {
        verified = verifySshSignature({ signature, message: challenge });
      } catch (error) {
        if (error instanceof SshKeyError) {
          throw errorResponse(error.message, 401);
        }
        throw error;
      }

      const key = await findSshKeyByFingerprint(verified.fingerprint);
      if (!key) {
        // Naming the fingerprint is what makes this actionable: it is the same
        // string `ssh-keygen -lf` prints, so the user can tell which of their
        // keys the CLI reached for.
        throw errorResponse(
          `SSH key ${verified.fingerprint} is not registered. Add it under user settings.`,
          401,
        );
      }

      const { spaces, error } = await listCliTokenSpaces(key.userId);
      if (error) {
        return jsonResponse({ error }, 403);
      }

      // Which space a token opens is never inferred when it would be a guess:
      // one candidate is an answer, several is a question for the caller.
      const selected = spaceId
        ? spaces.find((space) => space.id === spaceId)
        : spaces.length === 1
          ? spaces[0]
          : undefined;

      if (!selected) {
        if (spaceId) {
          throw errorResponse("Selected space is not available to this user", 403);
        }
        return jsonResponse(
          {
            error: "space_required",
            spaces: spaces.map((space) => ({
              id: space.id,
              name: space.name,
              slug: space.slug,
              role: space.userRole,
            })),
          },
          400,
        );
      }

      const result = await mintCliToken({
        userId: key.userId,
        spaceId: selected.id,
        label: `CLI via SSH ${key.name}`,
      });

      // Last use is reporting, not authorization — a failed write must not cost
      // the user a login they already proved.
      await markSshKeyUsed(key.id).catch((cause) =>
        appLogger.warn("Failed to record SSH key use", { error: cause }),
      );

      return jsonResponse(result);
    },
    {
      fallbackMessage: "SSH login failed",
      onError: (error) =>
        error instanceof CliTokenError
          ? errorResponse(error.message, error.status)
          : undefined,
    },
  );
