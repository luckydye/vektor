/**
 * What credential a request carries, as plain data.
 *
 * The guards decide access from this rather than from a Hono context, so the
 * decision path can be called — and tested — without constructing a request.
 * Reading a credential off the transport is the API layer's job; this module
 * owns the vocabulary and the one piece of parsing that has a rule to it.
 *
 * Deliberately free of `#api`: nothing here throws a `Response`, because "no
 * credential" is an input to a decision and not yet a refusal.
 */

import type { User } from "better-auth";

/** The prefix every space access token carries, and how one is told apart. */
const ACCESS_TOKEN_PREFIX = "at_";

export interface RequestCredentials {
  /**
   * `X-Job-Token`: a server-minted credential. Carried raw — it is HMAC-signed
   * against a space, so only {@link parseJobToken} can say what it means.
   */
  jobToken: string | null;
  /** A space access token, already unwrapped from `Bearer ` and prefix-checked. */
  accessToken: string | null;
  /** The signed-in user, when the request carries a session. */
  sessionUser: User | null;
}

/** A caller who presented nothing. The public case, stated rather than implied. */
export const ANONYMOUS: RequestCredentials = {
  jobToken: null,
  accessToken: null,
  sessionUser: null,
};

/**
 * The access token in an `Authorization` header, or null when there is none.
 *
 * Accepts `Bearer at_x` and a bare `at_x`. A header without the prefix is not a
 * space access token at all — a session bearer, say — and is left for another
 * scheme to claim rather than reported as a malformed one.
 */
export function parseAccessTokenHeader(
  authorization: string | null | undefined,
): string | null {
  if (!authorization) return null;
  const value = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : authorization;
  return value.startsWith(ACCESS_TOKEN_PREFIX) ? value : null;
}

/**
 * Read the credentials out of request headers, plus whatever session the
 * transport already resolved.
 *
 * Takes a Web `Headers` rather than a framework request, so one adapter serves
 * the Hono routes, Astro's SSR pages, a WebSocket upgrade, and a test that
 * builds the headers by hand.
 */
export function credentialsFromHeaders(
  headers: Headers,
  sessionUser?: User | null,
): RequestCredentials {
  return {
    jobToken: headers.get("X-Job-Token"),
    accessToken: parseAccessTokenHeader(headers.get("Authorization")),
    sessionUser: sessionUser ?? null,
  };
}

/** Whether `credentials` names a person, as opposed to a machine or nobody. */
export function hasSession(
  credentials: RequestCredentials,
): credentials is RequestCredentials & { sessionUser: User } {
  return credentials.sessionUser !== null;
}
