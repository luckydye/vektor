/**
 * What a document is called in the system it syncs with, and what that system
 * last saw of it.
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

/** Every identity pointing at one document. */
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
 * An insert, not an upsert: claiming a taken identity is a race the caller has
 * to hear about, and the unique index is what tells it. Call inside the
 * transaction that creates the document, so a lost race leaves no orphan.
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
 * Record what the peer has seen. A document still sitting at `syncedChangeSeq`
 * has not been edited locally since; anything higher is a local edit.
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
