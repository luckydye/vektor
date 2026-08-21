import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AclKind, Permission, type ResourceType } from "#acl/permissions.ts";
import { logAclChange } from "#acl/store.ts";
import { config } from "#config";
import { getIndexedSpace, getIndexedSpaceBySlug } from "#db/auth/spaceIndex.ts";
import { initializeDatabases } from "#db/client/db.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import type { AclEntry } from "#db/schema/space.ts";
import { acl } from "#db/schema/space.ts";

interface CreateShareLinkOptions {
  name: string;
  resourceType: ResourceType;
  resourceId: string;
  expiresAt: Date;
  password?: string;
  createdBy: string;
}

interface ShareLinkSummary {
  id: string;
  name: string | null;
  resourceType: string;
  resourceId: string;
  hasPassword: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
  revokedAt: Date | null;
}

type ValidatedShareLink = AclEntry & { userId: string };

/** Matches the one row that is this link, and never an access token. */
function linkRow(linkId: string) {
  return and(eq(acl.userId, linkId), eq(acl.kind, AclKind.LINK));
}

function toSummary(row: AclEntry): ShareLinkSummary {
  return {
    id: row.userId ?? "",
    name: row.name,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    hasPassword: row.secret !== null,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    revokedAt: row.revokedAt,
  };
}

export async function createShareLink(
  s: SpaceStore,
  options: CreateShareLinkOptions,
): Promise<{ id: string; path: string }> {
  const space = await getIndexedSpace(s.spaceId);
  if (!space) throw new Error(`Active space not found: ${s.spaceId}`);

  const id = createId("shareLink");
  const now = new Date();

  await s.db.insert(acl).values({
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    userId: id,
    groupId: null,
    permission: Permission.VIEWER,
    createdAt: now,
    updatedAt: now,
    name: options.name,
    secret: options.password ? await Bun.password.hash(options.password) : null,
    kind: AclKind.LINK,
    expiresAt: options.expiresAt,
    lastUsedAt: null,
    createdBy: options.createdBy,
    revokedAt: null,
  });

  await logAclChange(s, s.spaceId, {
    event: "acl_grant",
    kind: AclKind.LINK,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    userId: id,
    permission: Permission.VIEWER,
    actorUserId: options.createdBy,
  });

  return { id, path: `/${space.slug}/s/${id}` };
}

export async function validateShareLink(
  s: SpaceStore,
  linkId: string,
): Promise<ValidatedShareLink | null> {
  const [row] = await s.db.select().from(acl).where(linkRow(linkId)).limit(1);

  if (!row?.userId || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  return row as ValidatedShareLink;
}

/** Resolve only the space named by the URL; invented ids must not scan all spaces. */
export async function findShareLink(
  spaceSlug: string,
  linkId: string,
): Promise<{ link: ValidatedShareLink; spaceId: string } | null> {
  await initializeDatabases();

  const space = await getIndexedSpaceBySlug(spaceSlug);
  if (!space) return null;

  const result = await validateShareLink(await openSpaceStore(space.spaceId), linkId);
  return result ? { link: result, spaceId: space.spaceId } : null;
}

/**
 * HMAC proof bound to the stored verifier, so password changes invalidate it.
 * Returning null without AUTH_SECRET fails protected attachment access closed.
 */
export function shareLinkProof(link: AclEntry): string | null {
  if (!link.secret || !link.userId) return null;

  const key = config().AUTH_SECRET?.trim();
  if (!key) return null;

  return createHmac("sha256", key)
    .update(`share-link:${link.userId}:${link.secret}`)
    .digest("hex");
}

/** Constant-time proof check; an unprotected link needs no proof. */
export function verifyShareLinkProof(link: AclEntry, proof: string | null): boolean {
  if (!link.secret) return true;

  const expected = shareLinkProof(link);
  if (!expected || !proof || proof.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}

export async function markShareLinkUsed(s: SpaceStore, linkId: string): Promise<void> {
  await s.db.update(acl).set({ lastUsedAt: new Date() }).where(linkRow(linkId));
}

export async function listShareLinks(
  s: SpaceStore,
  resource: { resourceId: string; resourceTypes: ResourceType[] },
): Promise<ShareLinkSummary[]> {
  const rows = await s.db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.kind, AclKind.LINK),
        eq(acl.resourceId, resource.resourceId),
        inArray(acl.resourceType, resource.resourceTypes),
      ),
    );

  return rows.map(toSummary);
}

export async function getShareLink(
  s: SpaceStore,
  linkId: string,
): Promise<ShareLinkSummary | null> {
  const [row] = await s.db.select().from(acl).where(linkRow(linkId)).limit(1);
  return row ? toSummary(row) : null;
}

export async function revokeShareLink(
  s: SpaceStore,
  link: ShareLinkSummary,
  actorUserId: string,
): Promise<void> {
  await s.db
    .update(acl)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(linkRow(link.id));

  // Re-revoking succeeds but must not write a second audit entry.
  if (!link.revokedAt) {
    await logAclChange(s, s.spaceId, {
      event: "acl_revoke",
      kind: AclKind.LINK,
      resourceType: link.resourceType as ResourceType,
      resourceId: link.resourceId,
      userId: link.id,
      previousPermission: Permission.VIEWER,
      actorUserId,
    });
  }
}
