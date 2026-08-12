/**
 * The one rule for reading a document's revision history.
 *
 * Three endpoints expose the same data — `GET /documents/:id?rev=N`,
 * `GET /documents/:id/revisions` and `GET /documents/:id/diff?rev=N` — and each
 * used to carry its own gate, so the weakest of the three decided what was
 * actually protected: `?rev=N` and `/diff` handed out any revision (including
 * unpublished drafts of a publicly shared document) to anyone who could read
 * the published document, while `/revisions` required `VIEW_HISTORY`. All three
 * call {@link verifyRevisionAccess} now, so the rule cannot diverge again.
 *
 * The rule, in the order it is applied:
 *
 *  1. Serving exactly the published revision needs nothing beyond the read
 *     access the caller already has: it is the same snapshot the plain document
 *     GET returns.
 *  2. Any other revision is history → `Feature.VIEW_HISTORY`, the gate
 *     `/revisions` has always applied. This is deliberately *not* implied by a
 *     role: an explicit feature deny keeps out editors and owners too, exactly
 *     as it does on `/revisions`.
 *  3. A revision that was never published — one after `publishedRev`, or any
 *     revision at all while the document has nothing published — additionally
 *     requires `Permission.EDITOR`. The publish boundary is a role boundary; no
 *     feature grant crosses it, so a viewer with `VIEW_HISTORY` reads older
 *     published revisions but never a draft.
 *
 * This *refines* a route's read gate, it does not replace it: every caller must
 * still have passed its own `verifyDocumentRole`/`verifyTokenPermission` check
 * for plain read access before asking about revisions.
 */

import { verifyDocumentRole, verifyTokenPermission } from "#acl/guards.ts";
import { Feature, Permission, PUBLIC_GROUP, ResourceType } from "#acl/permissions.ts";
import { getUserGroups, hasFeature } from "#acl/store.ts";
import { forbiddenResponse, notFoundResponse } from "#api/http.ts";
import { openSpaceStore } from "#db/client/store.ts";
import type { ValidateTokenResult } from "#db/space/accessTokens.ts";
import { getTokenUserId } from "#db/space/accessTokens.ts";
import { getDocument } from "#db/space/documents.ts";

/**
 * Who is asking, in whichever form the route resolved its credential.
 *
 *  - `system`: a user-less HMAC job token, trusted within its space (the same
 *    credential the routes already skip per-document checks for).
 *  - `user`: a session, or a job token carrying the initiating user's id.
 *    `userId: null` is an unauthenticated caller, admitted through the `public`
 *    group — the case audit 043 was reported against.
 *  - `token`: a space access token, whose authority is its own ACL entries.
 */
export type RevisionReader =
  | { type: "system" }
  | { type: "user"; userId: string | null }
  | { type: "token"; token: ValidateTokenResult };

/** `requiredRole` on the document, for whichever identity the reader carries. Throws 401/403/404. */
async function verifyReaderRole(
  spaceId: string,
  documentId: string,
  reader: RevisionReader,
  requiredRole: Permission,
): Promise<void> {
  if (reader.type === "system") return;
  if (reader.type === "token") {
    await verifyTokenPermission(
      reader.token,
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      requiredRole,
    );
    return;
  }
  // `null` (unauthenticated) is handled inside: it resolves against the
  // `public` group, so a public-group grant is neither more nor less than the
  // role it was granted.
  await verifyDocumentRole(spaceId, documentId, reader.userId, requiredRole);
}

/**
 * `feature` for whichever identity the reader carries. Throws 403.
 *
 * A `system` reader is excluded by type rather than waved through here: a
 * trusted system token never reaches a feature check, and the caller has to
 * have said so.
 */
async function verifyReaderFeature(
  spaceId: string,
  reader: Exclude<RevisionReader, { type: "system" }>,
  feature: Feature,
): Promise<void> {
  const granted =
    reader.type === "token"
      ? await hasFeature(spaceId, feature, getTokenUserId(reader.token.tokenId))
      : reader.userId === null
        ? // Unauthenticated: the `public` group is the only grantee it can be.
          await hasFeature(spaceId, feature, "", [PUBLIC_GROUP])
        : await hasFeature(
            spaceId,
            feature,
            reader.userId,
            await getUserGroups(reader.userId),
          );

  if (!granted) {
    throw forbiddenResponse(
      `You don't have access to the ${feature.replace("_", " ")} feature`,
    );
  }
}

/**
 * Authorize a read of a document's revision history. Throws a 401/403/404
 * Response when the caller may not have it.
 *
 * @param revs The revisions whose **content** is about to be served. Omit (or
 *   pass an empty array) for a metadata-only listing of the whole history,
 *   which is treated as history access without a published-snapshot exemption.
 *
 * @example
 * ```ts
 * // GET /documents/:id?rev=N — anonymous callers included
 * await verifyRevisionAccess(spaceId, id, { type: "user", userId: null }, [rev]);
 *
 * // GET /documents/:id/revisions — metadata listing
 * await verifyRevisionAccess(spaceId, id, { type: "user", userId: user.id });
 * ```
 */
export async function verifyRevisionAccess(
  spaceId: string,
  documentId: string,
  reader: RevisionReader,
  revs?: readonly number[],
): Promise<void> {
  // A user-less system token is the space's own background work; it reads the
  // history the same way the publish/notification paths do.
  if (reader.type === "system") return;

  const requested = revs ?? [];

  let publishedRev: number | null = null;
  if (requested.length > 0) {
    const document = await getDocument(await openSpaceStore(spaceId), documentId);
    if (!document) {
      throw notFoundResponse("Document");
    }
    publishedRev = document.publishedRev;

    // The published snapshot is what plain read access already buys.
    if (publishedRev !== null && requested.every((rev) => rev === publishedRev)) {
      return;
    }
  }

  await verifyReaderFeature(spaceId, reader, Feature.VIEW_HISTORY);

  // Never-published content stays behind the publish boundary.
  if (requested.some((rev) => publishedRev === null || rev > publishedRev)) {
    await verifyReaderRole(spaceId, documentId, reader, Permission.EDITOR);
  }
}
