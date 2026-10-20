/**
 * Who a request is, resolved the same way at every door.
 *
 * Three places turn a session into an identity — the API router, the Astro
 * middleware and the websocket upgrade — and each used to read it for itself,
 * so anything that has to hold for all three only held where it was remembered.
 */

import { getAuth } from "#auth";
import { isNoAuthMode, LOCAL_SESSION, LOCAL_USER } from "#config";
import type { Platform } from "#platform/platform.ts";

export interface RequestIdentity {
  user: App.Locals["user"];
  session: App.Locals["session"];
}

/**
 * The identity behind a request's headers; both fields are null when there is
 * none, and a refused session leaves neither half behind.
 */
export async function resolveRequestIdentity(
  platform: Platform,
  headers: Headers,
): Promise<RequestIdentity> {
  if (isNoAuthMode()) {
    return { user: LOCAL_USER, session: LOCAL_SESSION };
  }

  const authenticated = await getAuth(platform).api.getSession({ headers });
  if (!authenticated) return { user: null, session: null };

  return { user: authenticated.user, session: authenticated.session };
}
