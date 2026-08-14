/**
 * The one rule for reading a document's revision history, applied in order:
 *
 *  1. Exactly the published revision: plain read access, since the document GET
 *     serves the same content. Metadata is history, so the verdict says whether
 *     it may travel with it.
 *  2. Any other revision: `Feature.VIEW_HISTORY`, never implied by a role.
 *  3. Never published: also `Permission.EDITOR`.
 *
 * "Never published" is position plus status, so a suggestion stays behind the
 * boundary wherever the publish pointer later moves. This refines a route's read
 * gate rather than replacing it.
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
 *  - `system`: a user-less HMAC job token, trusted within its space.
 *  - `user`: a session, or a job token carrying the initiating user's id.
 *    `userId: null` is an unauthenticated caller (audit 043).
 *  - `token`: a space access token, whose authority is its own ACL entries.
 */
export type RevisionReader =
  | { type: "system" }
  | { type: "user"; userId: string | null }
  | { type: "token"; token: ValidateTokenResult };

/** Every reader but `system`, which is trusted before either check below runs. */
type CheckedReader = Exclude<RevisionReader, { type: "system" }>;

/**
 * Whether the reader may see history on this document. Scoped to the document
 * because a document- or tree-level share carries no space role.
 */
async function canViewHistory(
  spaceId: string,
  documentId: string,
  reader: CheckedReader,
): Promise<boolean> {
  const feature = Feature.VIEW_HISTORY;
  if (reader.type === "token") {
    return tokenHasFeature(reader.token, spaceId, feature, documentId);
  }
  if (reader.userId === null) {
    // Unauthenticated: the `public` group is the only grantee it can be.
    return hasFeature(spaceId, feature, "", [PUBLIC_GROUP], documentId);
  }
  const groups = await getUserGroups(reader.userId);
  return hasFeature(spaceId, feature, reader.userId, groups, documentId);
}

/** Editor on the document, whichever identity the reader carries. Throws 401/403/404. */
async function requireEditor(
  spaceId: string,
  documentId: string,
  reader: CheckedReader,
): Promise<void> {
  if (reader.type === "token") {
    await verifyTokenPermission(
      reader.token,
      spaceId,
      ResourceType.DOCUMENT,
      documentId,
      Permission.EDITOR,
    );
    return;
  }
  // `null` resolves against the `public` group inside.
  await verifyDocumentRole(spaceId, documentId, reader.userId, Permission.EDITOR);
}

/**
 * Whether `rev` is content the document never published. A missing revision
 * counts as never published, so a guess cannot buy the exemption.
 */
async function isNeverPublished(
  spaceId: string,
  documentId: string,
  rev: number,
  publishedRev: number | null,
): Promise<boolean> {
  if (publishedRev === null || rev > publishedRev) return true;

  const store = await openSpaceStore(spaceId);
  const metadata = await getRevisionMetadata(store, documentId, rev);
  return metadata === null || metadata.status !== null;
}

/**
 * What a caller may read of a revision, once authorized. `metadata` is false for
 * a snapshot-exemption caller without `VIEW_HISTORY`: content, but not the
 * authorship, message, checksum or lineage `/revisions` gates.
 */
export interface RevisionAccess {
  metadata: boolean;
}

/**
 * Authorize a read of a document's revision history. Throws a 401/403/404
 * Response when the caller may not have it.
 *
 * @param revs The revisions whose **content** is about to be served. Omit for a
 *   listing of the whole history, which gets no snapshot exemption.
 * @returns What may be served — see {@link RevisionAccess}.
 *
 * @example
 * ```ts
 * const access = await verifyRevisionAccess(spaceId, id, { type: "user", userId: null }, [rev]);
 * await verifyRevisionAccess(spaceId, id, { type: "user", userId: user.id });
 * ```
 */
export async function verifyRevisionAccess(
  spaceId: string,
  documentId: string,
  reader: RevisionReader,
  revs?: readonly number[],
): Promise<RevisionAccess> {
  // A user-less system token is the space's own background work.
  if (reader.type === "system") return { metadata: true };

  const requested = revs ?? [];

  let publishedRev: number | null = null;
  if (requested.length > 0) {
    const document = await getDocument(await openSpaceStore(spaceId), documentId);
    if (!document) {
      throw notFoundResponse("Document");
    }
    publishedRev = document.publishedRev;
  }

  const history = await canViewHistory(spaceId, documentId, reader);

  // Plain read access already buys the published snapshot's content.
  const snapshotOnly =
    requested.length > 0 && requested.every((rev) => rev === publishedRev);
  if (snapshotOnly) {
    return { metadata: history };
  }

  if (!history) {
    throw forbiddenResponse("You don't have access to the view history feature");
  }

  // Never-published content stays behind the publish boundary.
  const neverPublished = await Promise.all(
    requested.map((rev) => isNeverPublished(spaceId, documentId, rev, publishedRev)),
  );
  if (neverPublished.some(Boolean)) {
    await requireEditor(spaceId, documentId, reader);
  }

  return { metadata: true };
}
