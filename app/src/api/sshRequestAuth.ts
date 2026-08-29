/**
 * Authenticating a request by SSH signature — the CLI's credential, and the
 * whole of it.
 *
 * Nothing is issued and nothing is stored: the CLI signs each request with the
 * user's SSH key (see `#utils/sshRequestSignature.ts` for what the signature
 * covers) and the key's fingerprint names the account. A verified signature
 * resolves to that user and the request is then authorized exactly as a browser
 * session's is — the key carries no permissions of its own, only an identity.
 */

import { findSshKeyByFingerprint, markSshKeyUsed } from "#db/auth/sshKeys.ts";
import { getUserById } from "#db/auth/users.ts";
import { appLogger } from "#observability/logger.ts";
import { SshKeyError, verifySshSignature } from "#utils/sshKeys.ts";
import {
  canonicalRequest,
  isSshSignedAuthorization,
  parseAuthorization,
} from "#utils/sshRequestSignature.ts";

/**
 * How far a signature's clock may be from ours. Wide enough for an unsynced
 * laptop, narrow enough that a captured signature is stale before it is useful —
 * and inside the window it is the nonce that stops a second use.
 */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Nonces already spent, each with the moment it stops being worth remembering. */
const seenNonces = new Map<string, number>();

/**
 * A ceiling on what a caller can make this process remember. Reaching it means
 * more signed requests within the skew window than any client makes, so the
 * oldest entry gives way rather than the map growing without bound.
 */
const MAX_SEEN_NONCES = 20_000;

/** Whether a request presents a signature rather than some other credential. */
export function isSshSignedRequest(headers: Headers): boolean {
  return isSshSignedAuthorization(headers.get("Authorization"));
}

function dropExpiredNonces(now: number): void {
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(nonce);
  }
}

/** True the first time a nonce is seen inside its window, false ever after. */
function claimNonce(nonce: string, now: number): boolean {
  dropExpiredNonces(now);
  if (seenNonces.has(nonce)) return false;

  if (seenNonces.size >= MAX_SEEN_NONCES) {
    // Insertion order is age order, so the first entry is the oldest.
    const oldest = seenNonces.keys().next();
    if (!oldest.done) seenNonces.delete(oldest.value);
  }
  seenNonces.set(nonce, now + MAX_CLOCK_SKEW_MS);
  return true;
}

/** Last use is reporting, not authorization, so it is written at most this often per key. */
const KEY_USE_WRITE_INTERVAL_MS = 60_000;

const lastRecordedUse = new Map<string, number>();

function recordKeyUse(keyId: string): void {
  const now = Date.now();
  if (now - (lastRecordedUse.get(keyId) ?? 0) < KEY_USE_WRITE_INTERVAL_MS) return;

  lastRecordedUse.set(keyId, now);
  void markSshKeyUsed(keyId).catch((error) =>
    appLogger.warn("Failed to record SSH key use", { error }),
  );
}

/**
 * The user behind a signed request, or null when the signature does not check
 * out — stale, replayed, forged, or made by a key nobody registered.
 *
 * Silent on failure by design: a signature that does not verify is simply not an
 * identity, and the route's own guard turns that into the 401 it would have
 * given an anonymous caller anyway.
 *
 * @param request read for its body, which the signature covers. A clone is
 *   consumed, so the caller's copy stays intact.
 */
export async function resolveSshSignedUser(
  request: Request,
): Promise<App.Locals["user"] | null> {
  const presented = parseAuthorization(request.headers.get("Authorization"));
  if (!presented) return null;

  const now = Date.now();
  if (Math.abs(now - presented.timestamp * 1000) > MAX_CLOCK_SKEW_MS) return null;
  if (!claimNonce(presented.nonce, now)) return null;

  const url = new URL(request.url);
  const body = request.body
    ? new Uint8Array(await request.clone().arrayBuffer())
    : new Uint8Array();

  const message = canonicalRequest({
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body,
    timestamp: presented.timestamp,
    nonce: presented.nonce,
  });

  let fingerprint: string;
  try {
    fingerprint = verifySshSignature({
      signature: presented.signature,
      message,
    }).fingerprint;
  } catch (error) {
    if (error instanceof SshKeyError) return null;
    throw error;
  }

  const key = await findSshKeyByFingerprint(fingerprint);
  if (!key) return null;

  const user = await getUserById(key.userId);
  if (!user) return null;

  recordKeyUse(key.id);
  return user;
}
