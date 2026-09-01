/**
 * What a document is called in the system it syncs with, and what that system
 * last saw of it.
 *
 * A peer names things by its own identifier — a calendar event's `UID`, an issue
 * key — and needs to write "the document for this identifier" without first
 * asking whether one exists. The unique index on the identity does that: two
 * runs racing to import one event contend on a single row instead of producing
 * two documents.
 */

import { and, eq } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { externalLink } from "#db/schema/space.ts";

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
}

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
    s.db
      .select({
        source: externalLink.source,
        externalId: externalLink.externalId,
        instanceId: externalLink.instanceId,
        documentId: externalLink.documentId,
        remoteVersion: externalLink.remoteVersion,
        syncedChangeSeq: externalLink.syncedChangeSeq,
      })
      .from(externalLink)
      .where(externalIdentityCondition(identity)),
  );
  return row ?? null;
}

/** Every identity pointing at one document, for the reverse lookup a push needs. */
export async function listExternalLinksForDocument(
  s: SpaceStore,
  documentId: string,
): Promise<ExternalLink[]> {
  return many(
    s.db
      .select({
        source: externalLink.source,
        externalId: externalLink.externalId,
        instanceId: externalLink.instanceId,
        documentId: externalLink.documentId,
        remoteVersion: externalLink.remoteVersion,
        syncedChangeSeq: externalLink.syncedChangeSeq,
      })
      .from(externalLink)
      .where(eq(externalLink.documentId, documentId)),
  );
}

/**
 * Claim an identity for a document.
 *
 * Deliberately an insert and not an upsert: claiming an identity that is
 * already claimed is a race the caller has to hear about, and the unique index
 * is what tells it. Call this inside the transaction that creates the document,
 * so a lost race takes the document with it rather than leaving an orphan.
 */
export async function claimExternalIdentity(
  s: SpaceStore,
  identity: ExternalIdentity,
  documentId: string,
  remoteVersion: string | null,
  syncedChangeSeq: number,
): Promise<void> {
  const now = new Date();
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

/**
 * Record what the peer has now seen.
 *
 * `syncedChangeSeq` is the sequence this sync itself wrote. A document sitting
 * at that value has not been touched locally since; anything higher is a local
 * edit the peer does not know about yet, which is the whole reason to store it.
 */
export async function markExternalSynced(
  s: SpaceStore,
  identity: ExternalIdentity,
  remoteVersion: string | null,
  syncedChangeSeq: number,
): Promise<void> {
  await s.db
    .update(externalLink)
    .set({ remoteVersion, syncedChangeSeq, updatedAt: new Date() })
    .where(externalIdentityCondition(identity));
}
