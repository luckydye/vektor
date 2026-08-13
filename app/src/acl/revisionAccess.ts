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
 *     access the caller already has: the plain document GET returns the same
 *     *content*. Only the content — who wrote it and why is history, so the
 *     verdict reports whether metadata may travel with it.
 *  2. Any other revision is history → `Feature.VIEW_HISTORY`, the gate
 *     `/revisions` has always applied. This is deliberately *not* implied by a
 *     role: an explicit feature deny keeps out editors and owners too, exactly
 *     as it does on `/revisions`.
 *  3. A revision that was never published additionally requires
 *     `Permission.EDITOR`, so a viewer with `VIEW_HISTORY` reads published
 *     history but never a draft or a proposal.
 *
 * "Never published" is position plus status: a suggestion is a proposal any
 * viewer can create, and a later publish moving past it never made it published,
 * so it stays behind the boundary wherever it sits. Position alone cannot tell a
 * once-published save from an intermediate draft below the pointer — the schema
 * records no publication history — so both count as published history.
 *
 * This *refines* a route's read gate, it does not replace it: every caller must
 * still have passed its own `verifyDocumentRole`/`verifyTokenPermission` check
 * for plain read access before asking about revisions.
 */

import {
  tokenHasFeature,
  verifyDocumentRole,
  verifyTokenPermission,
} from "#acl/guards.ts";
import { Feature, Permission, PUBLIC_GROUP, ResourceType } from "#acl/permissions.ts";
import { getUserGroups, hasFeature } from "#acl/store.ts";
import { forbiddenResponse, notFoundResponse } from "#api/http.ts";
import { openSpaceStore } from "#db/client/store.ts";
import type { ValidateTokenResult } from "#db/space/accessTokens.ts";
import { getDocument } from "#db/space/documents.ts";
import { getRevisionMetadata } from "#db/space/revisions.ts";

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
 * Whether the reader holds `feature` on this document.
 *
 * The feature is resolved against the document rather than the space: someone
 * who reaches it through a document- or tree-level share holds no space role,
 * and a space-scoped fallback would refuse them history on a document they can
 * edit. Explicit feature grants and denies still decide first, so the
 * `/revisions` behaviour of a deny outranking any role is unchanged.
 *
 * A `system` reader is excluded by type rather than waved through here: a
 * trusted system token never reaches a feature check, and the caller has to
 * have said so.
 */
async function readerHasFeature(
  spaceId: string,
  documentId: string,
  reader: Exclude<RevisionReader, { type: "system" }>,
  feature: Feature,
): Promise<boolean> {
  if (reader.type === "token") {
    return tokenHasFeature(reader.token, spaceId, feature, documentId);
  }
  if (reader.userId === null) {
    // Unauthenticated: the `public` group is the only grantee it can be.
    return hasFeature(spaceId, feature, "", [PUBLIC_GROUP], documentId);
  }
  return hasFeature(
    spaceId,
    feature,
    reader.userId,
    await getUserGroups(reader.userId),
    documentId,
  );
}

/** {@link readerHasFeature}, as a guard: throws 403 when the reader lacks it. */
async function verifyReaderFeature(
  spaceId: string,
  documentId: string,
  reader: Exclude<RevisionReader, { type: "system" }>,
  feature: Feature,
): Promise<void> {
  if (!(await readerHasFeature(spaceId, documentId, reader, feature))) {
    throw forbiddenResponse(
      `You don't have access to the ${feature.replace("_", " ")} feature`,
    );
  }
}

/**
 * Whether `rev` is content the document never published.
 *
 * A missing revision counts as never published: the caller learns nothing from
 * the distinction (it is refused either way, and the route 404s afterwards),
 * and guessing the other way would exempt revisions that do not exist.
 */
async function isNeverPublished(
  spaceId: string,
  documentId: string,
  rev: number,
  publishedRev: number | null,
): Promise<boolean> {
  if (publishedRev === null || rev > publishedRev) return true;

  const metadata = await getRevisionMetadata(
    await openSpaceStore(spaceId),
    documentId,
    rev,
  );
  return metadata === null || metadata.status !== null;
}

/**
 * What a caller may read of a revision, once authorized.
 *
 * `metadata` is false when only the published-snapshot exemption admitted the
 * caller and it holds no `VIEW_HISTORY`: it may have the content, which the
 * plain document GET would serve anyway, but not the authorship, message,
 * checksum or lineage that `/revisions` gates behind the feature.
 */
export interface RevisionAccess {
  metadata: boolean;
}

/**
 * Authorize a read of a document's revision history. Throws a 401/403/404
 * Response when the caller may not have it.
 *
 * @param revs The revisions whose **content** is about to be served. Omit (or
 *   pass an empty array) for a metadata-only listing of the whole history,
 *   which is treated as history access without a published-snapshot exemption.
 * @returns What may be served — see {@link RevisionAccess}.
 *
 * @example
 * ```ts
 * // GET /documents/:id?rev=N — anonymous callers included
 * const access = await verifyRevisionAccess(spaceId, id, { type: "user", userId: null }, [rev]);
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
): Promise<RevisionAccess> {
  // A user-less system token is the space's own background work; it reads the
  // history the same way the publish/notification paths do.
  if (reader.type === "system") return { metadata: true };

  const requested = revs ?? [];

  let publishedRev: number | null = null;
  if (requested.length > 0) {
    const document = await getDocument(await openSpaceStore(spaceId), documentId);
    if (!document) {
      throw notFoundResponse("Document");
    }
    publishedRev = document.publishedRev;

    // The published snapshot is what plain read access already buys — its
    // content, and nothing that describes it unless the caller could have read
    // that description from the history anyway.
    if (publishedRev !== null && requested.every((rev) => rev === publishedRev)) {
      return {
        metadata: await readerHasFeature(
          spaceId,
          documentId,
          reader,
          Feature.VIEW_HISTORY,
        ),
      };
    }
  }

  await verifyReaderFeature(spaceId, documentId, reader, Feature.VIEW_HISTORY);

  // Never-published content stays behind the publish boundary.
  const neverPublished = await Promise.all(
    requested.map((rev) => isNeverPublished(spaceId, documentId, rev, publishedRev)),
  );
  if (neverPublished.some(Boolean)) {
    await verifyReaderRole(spaceId, documentId, reader, Permission.EDITOR);
  }

  return { metadata: true };
}
