/**
 * What a document is called in the system it syncs with, and where that sync
 * got to.
 *
 * Built for a consumer that stores nothing between runs: everything it would
 * otherwise have to remember lives on the row, keyed by `source`, so two
 * consumers of one document keep independent progress. A run reconciles by
 * scanning its source's rows and diffing against what the peer holds now —
 * no cursor to keep, and a run that dies just reconciles again.
 */

import { and, asc, eq, gt, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { document, externalLink } from "#db/schema/space.ts";
import { workflowRunDocumentType } from "#documents/types.ts";

/** What a peer calls one thing. Empty `instanceId` is the series itself. */
export interface ExternalIdentity {
  source: string;
  externalId: string;
  instanceId: string;
}

export interface ExternalLink extends ExternalIdentity {
  documentId: string;
  remoteVersion: string | null;
  syncedChangeSeq: number | null;
  deletedAt: Date | null;
}

/** A link and the document's current position, which is the whole diff input. */
export interface ExternalLinkState {
  link: ExternalLink;
  /** Null once the document is gone — `link.deletedAt` says when. */
  changeSeq: number | null;
}

const linkColumns = {
  source: externalLink.source,
  externalId: externalLink.externalId,
  instanceId: externalLink.instanceId,
  documentId: externalLink.documentId,
  remoteVersion: externalLink.remoteVersion,
  syncedChangeSeq: externalLink.syncedChangeSeq,
  deletedAt: externalLink.deletedAt,
};

export function externalIdentityCondition(identity: ExternalIdentity) {
  return and(
    eq(externalLink.source, identity.source),
    eq(externalLink.externalId, identity.externalId),
    eq(externalLink.instanceId, identity.instanceId),
  );
}

export async function findExternalLink(
  s: SpaceStore,
  identity: ExternalIdentity,
): Promise<ExternalLink | null> {
  const row = await one(
    s.db.select(linkColumns).from(externalLink).where(externalIdentityCondition(identity)),
  );
  return row ?? null;
}

/**
 * One page of a source's links, oldest identifier first.
 *
 * Paged on `externalId` rather than a timestamp: it is unique within a source
 * and never changes, so a reconciliation pass that spans several requests sees
 * each identity exactly once even while documents are being written. The
 * default listing's `updatedAt` cursor cannot promise that.
 *
 * Deleted links are included. A consumer with no memory of its own cannot tell
 * "deleted here" from "never imported", and leaving them out would have it
 * recreate what someone deleted.
 */
export async function listExternalLinks(
  s: SpaceStore,
  source: string,
  options: { limit: number; after?: string },
): Promise<ExternalLinkState[]> {
  const rows = await many(
    s.db
      .select({ ...linkColumns, changeSeq: document.changeSeq })
      .from(externalLink)
      .leftJoin(document, eq(document.id, externalLink.documentId))
      .where(
        options.after
          ? and(
              eq(externalLink.source, source),
              gt(externalLink.externalId, options.after),
            )
          : eq(externalLink.source, source),
      )
      .orderBy(asc(externalLink.externalId), asc(externalLink.instanceId))
      .limit(options.limit),
  );

  return rows.map(({ changeSeq, ...link }) => ({ link, changeSeq }));
}

/**
 * Document ids this source has no link for — what it has never been told about.
 *
 * The other half of reconciliation: a source's own rows say what it knows, and
 * this says what it is missing. Without it a document created here is invisible
 * to every consumer.
 */
export async function listUnlinkedDocumentIds(
  s: SpaceStore,
  source: string,
  options: { limit: number; after?: string },
): Promise<string[]> {
  const claimed = s.db
    .select({ documentId: externalLink.documentId })
    .from(externalLink)
    .where(eq(externalLink.source, source));

  const rows = await many(
    s.db
      .select({ id: document.id })
      .from(document)
      .where(
        and(
          notInArray(document.id, claimed),
          // Runs are not documents a peer could do anything with, and they
          // outnumber everything else. `IS NULL OR !=` because most documents
          // have no type, and a null is not `!=` anything in SQL.
          or(isNull(document.type), ne(document.type, workflowRunDocumentType)),
          ...(options.after ? [gt(document.id, options.after)] : []),
        ),
      )
      .orderBy(asc(document.id))
      .limit(options.limit),
  );
  return rows.map((row) => row.id);
}

/**
 * Claim an identity for a document.
 *
 * An insert, not an upsert: claiming a taken identity is a race the caller has
 * to hear about, and the unique index is what tells it. Call inside the
 * transaction that creates the document, so a lost race leaves no orphan.
 *
 * A deleted link is reclaimable — the peer re-creating something under an
 * identifier it once used is a new thing here, not a resurrection — so the row
 * is repointed rather than refused.
 */
export async function claimExternalIdentity(
  s: SpaceStore,
  identity: ExternalIdentity,
  documentId: string,
  remoteVersion: string | null,
  syncedChangeSeq: number,
): Promise<void> {
  const now = new Date();
  const reclaimed = await many(
    s.db
      .update(externalLink)
      .set({ documentId, remoteVersion, syncedChangeSeq, deletedAt: null, updatedAt: now })
      .where(and(externalIdentityCondition(identity), isNotNull(externalLink.deletedAt)))
      .returning({ id: externalLink.id }),
  );
  if (reclaimed.length > 0) return;

  await s.db.insert(externalLink).values({
    id: createId("externalLink"),
    ...identity,
    documentId,
    remoteVersion,
    syncedChangeSeq,
    createdAt: now,
    updatedAt: now,
  });
}

/** Record what the peer has now seen, only while the link still names this state. */
export async function markExternalSynced(
  s: SpaceStore,
  identity: ExternalIdentity,
  values: { remoteVersion?: string | null; syncedChangeSeq: number },
  expectedSyncedChangeSeq?: number,
): Promise<boolean> {
  // Two workers on one source share the row, so the write carries the value it
  // read where the caller supplies one.
  const guard =
    expectedSyncedChangeSeq === undefined
      ? undefined
      : eq(externalLink.syncedChangeSeq, expectedSyncedChangeSeq);

  const rows = await many(
    s.db
      .update(externalLink)
      .set({
        ...(values.remoteVersion === undefined
          ? {}
          : { remoteVersion: values.remoteVersion }),
        syncedChangeSeq: values.syncedChangeSeq,
        updatedAt: new Date(),
      })
      .where(
        guard
          ? and(externalIdentityCondition(identity), guard)
          : externalIdentityCondition(identity),
      )
      .returning({ id: externalLink.id }),
  );
  return rows.length > 0;
}

/**
 * Mark every identity of a deleted document, in the transaction that deletes it.
 *
 * The rows carry no foreign key precisely so they can outlive the document: the
 * identity is the only thing that can tell a consumer a deletion happened
 * rather than an import never having happened.
 */
export async function markExternalLinksDeleted(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  const now = new Date();
  await s.db
    .update(externalLink)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(externalLink.documentId, documentId), isNull(externalLink.deletedAt)));
}

/** SQLite names the index it rejected; nothing else on the claim path can fail so. */
export function isExternalIdentityTaken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
