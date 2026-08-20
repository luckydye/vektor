/**
 * The request edge of authorization: a Hono context in, the plain credentials a
 * guard reads out. One direction only, so `#acl` never imports `#api`.
 */

import type { CallerCredentials } from "#acl/guards.ts";
import type { ApiContext } from "#api/server/types.ts";

/** The three things a guard reads off a request, and nothing more. */
export function requestCredentials(context: ApiContext): CallerCredentials {
  return {
    jobToken: context.req.raw.headers.get("X-Job-Token"),
    authorization: context.req.raw.headers.get("Authorization"),
    user: context.var.user,
  };
}
