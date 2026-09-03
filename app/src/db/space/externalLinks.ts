/** The map from a peer's own identifier to a document. */

import { and, eq } from "drizzle-orm";
import { one } from "#db/client/query.ts";
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
      })
      .from(externalLink)
      .where(externalIdentityCondition(identity)),
  );
  return row ?? null;
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
): Promise<void> {
  const now = new Date();
  await s.db.insert(externalLink).values({
    id: createId("externalLink"),
    ...identity,
    documentId,
    createdAt: now,
    updatedAt: now,
  });
}

/** SQLite names the index it rejected; nothing else on the claim path can fail so. */
export function isExternalIdentityTaken(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UNIQUE constraint failed");
}
