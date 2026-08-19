/**
 * Who a request is, resolved the same way at every door.
 *
 * Four places turn credentials into an identity — the API router, the Astro
 * middleware, the websocket upgrade and CalDAV's Basic auth — and each used to
 * read the session for itself, so a rule that has to hold for all four only
 * held where someone remembered it.
 */

import { isCredentialPrincipal } from "#acl/permissions.ts";
import { auth } from "#auth";
import { isNoAuthMode, LOCAL_SESSION, LOCAL_USER } from "#noAuth";
import { appLogger } from "#observability/logger.ts";

export interface RequestIdentity {
  user: App.Locals["user"];
  session: App.Locals["session"];
}

/**
 * A user admitted as a person, or null. Every guard reads a credential-shaped
 * id as a credential — no groups, no admin, absent from the member lists — so a
 * person carrying one is refused loudly rather than silently demoted.
 */
export function personPrincipal<T extends { id: string }>(
  user: T | null | undefined,
): T | null {
  if (!user) return null;
  if (isCredentialPrincipal(user.id)) {
    appLogger.error("Refusing a user id shaped like a credential's", { userId: user.id });
    return null;
  }
  return user;
}

/**
 * The identity behind a request's headers; both fields are null when there is
 * none, and a refused session leaves neither half behind.
 */
export async function resolveRequestIdentity(headers: Headers): Promise<RequestIdentity> {
  if (isNoAuthMode()) {
    return { user: LOCAL_USER, session: LOCAL_SESSION };
  }

  const authenticated = await auth.api.getSession({ headers });
  if (!authenticated) return { user: null, session: null };

  const user = personPrincipal(authenticated.user);
  if (!user) return { user: null, session: null };

  return { user, session: authenticated.session };
}
