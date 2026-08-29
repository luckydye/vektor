/**
 * POST /api/v1/auth/cli/ssh/challenge
 *
 * Opens an SSH login: hands the CLI a nonce to sign. Deliberately anonymous —
 * asking for a challenge proves nothing and learns nothing, in particular not
 * whether any given key is registered. That is settled at the exchange, where a
 * signature is on the table.
 *
 * The challenge is single-use and short-lived, so a signature captured from the
 * wire buys nothing: it names a nonce this server issued and has already spent.
 *
 * Returns: { challenge, namespace, hashAlgorithm, expiresAt }
 */

import { randomBytes } from "node:crypto";
import { jsonResponse, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { SSH_SIGNATURE_NAMESPACE } from "#utils/sshKeys.ts";

export const SSH_CHALLENGE_TTL_MS = 2 * 60_000;

/** The hash SSHSIG covers the challenge with; the CLI is told rather than left to guess. */
export const SSH_CHALLENGE_HASH = "sha512";

/** Outstanding challenges: challenge → expiry. Nothing about the caller is known yet. */
export const pendingSshChallenges = new Map<string, number>();

/**
 * Cheap enough to hold, low enough that an unauthenticated flood cannot grow the
 * map without bound before the route's rate limit turns it away.
 */
const MAX_PENDING_CHALLENGES = 1_000;

function dropExpiredChallenges(): void {
  const now = Date.now();
  for (const [challenge, expiresAt] of pendingSshChallenges) {
    if (expiresAt <= now) pendingSshChallenges.delete(challenge);
  }
}

/**
 * Spend a challenge: valid once, and only before it expires.
 *
 * Removed whether or not the caller goes on to prove anything, so a nonce a
 * signature was captured for cannot be presented twice.
 */
export function consumeSshChallenge(challenge: string): boolean {
  const expiresAt = pendingSshChallenges.get(challenge);
  if (expiresAt === undefined) return false;
  pendingSshChallenges.delete(challenge);
  return expiresAt > Date.now();
}

export const POST: ApiRouteHandler = () =>
  withApiErrorHandling(() => {
    dropExpiredChallenges();
    // An expiring entry frees a slot on the next request, so a full map means
    // this many live challenges — not a leak to make room in.
    if (pendingSshChallenges.size >= MAX_PENDING_CHALLENGES) {
      return jsonResponse({ error: "Too many pending logins, try again shortly" }, 503);
    }

    const challenge = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SSH_CHALLENGE_TTL_MS;
    pendingSshChallenges.set(challenge, expiresAt);

    return jsonResponse({
      challenge,
      namespace: SSH_SIGNATURE_NAMESPACE,
      hashAlgorithm: SSH_CHALLENGE_HASH,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }, "Failed to start SSH login");
