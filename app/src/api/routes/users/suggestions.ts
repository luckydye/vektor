import { getUsersInSharedGroups } from "#acl/store.ts";
import { jsonResponse, requireUser, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";

const MAX_SUGGESTIONS = 20;

/**
 * GET /api/v1/users/suggestions
 *
 * People the caller may invite: everyone who shares at least one OAuth group
 * with them (name + email + image). Powers the invite typeahead so an inviter
 * can pick a colleague instead of typing an email from memory. Returns an empty
 * list when the caller has no OAuth groups — there is no global directory.
 *
 * Optional `?q=` filters by a case-insensitive substring of name or email.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const caller = requireUser(context);

    const query = new URL(context.req.url).searchParams.get("q")?.trim().toLowerCase();

    const peers = await getUsersInSharedGroups(caller.id);

    const filtered = query
      ? peers.filter(
          (peer) =>
            peer.name.toLowerCase().includes(query) ||
            peer.email.toLowerCase().includes(query),
        )
      : peers;

    return jsonResponse(filtered.slice(0, MAX_SUGGESTIONS));
  }, "Failed to load invite suggestions");
