/**
 * GET  /api/v1/users/ssh-keys
 * POST /api/v1/users/ssh-keys
 *
 * The caller's own SSH public keys — what `vektor login --ssh` authenticates
 * against. Session-authenticated on purpose: a key is a standing credential for
 * every space its owner can reach, so it may only be registered by the person
 * themselves, never by a token scoped to one space.
 */

import {
  badRequestResponse,
  createdResponse,
  jsonResponse,
  parseJsonBody,
  requireUser,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { addUserSshKey, listUserSshKeys, SshKeyInUseError } from "#db/auth/sshKeys.ts";
import { SshKeyError } from "#utils/sshKeys.ts";

/** Long enough for any RSA key line with a comment, short enough to reject a paste of something else. */
const MAX_KEY_LINE_LENGTH = 16_384;

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    return jsonResponse({ keys: await listUserSshKeys(user.id) });
  }, "Failed to list SSH keys");

/**
 * Body:
 *   publicKey  one authorized_keys line, e.g. "ssh-ed25519 AAAA… you@host"
 *   name       optional label; the line's comment is used when omitted
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const user = requireUser(context);
    const body = await parseJsonBody(context.req.raw);
    const { publicKey, name } = body;

    if (typeof publicKey !== "string" || publicKey.trim().length === 0) {
      throw badRequestResponse("publicKey is required");
    }
    if (publicKey.length > MAX_KEY_LINE_LENGTH) {
      throw badRequestResponse("publicKey is too long to be an SSH public key");
    }
    if (name !== undefined && name !== null && typeof name !== "string") {
      throw badRequestResponse("name must be a string");
    }

    try {
      return createdResponse({
        key: await addUserSshKey(user.id, publicKey, name ?? undefined),
      });
    } catch (error) {
      // Both carry text written for whoever pasted the key.
      if (error instanceof SshKeyError || error instanceof SshKeyInUseError) {
        throw badRequestResponse(error.message);
      }
      throw error;
    }
  }, "Failed to add SSH key");
