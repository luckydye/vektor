/**
 * Share links. An `acl` row like an access token, with two differences `kind`
 * marks: an editor may mint one, and it outlives its creator — held down instead
 * by its viewer ceiling and its required expiry.
 *
 * The link's id is its URL, so holding the URL is access. A password puts a Basic
 * challenge in front of that, and its verifier is the row's `secret`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AclKind, Permission, type ResourceType } from "#acl/permissions.ts";
import { logAclChange } from "#acl/store.ts";
import { config } from "#config";
import { getIndexedSpace } from "#db/auth/spaceIndex.ts";
import { getAuthDb, initializeDatabases } from "#db/client/db.ts";
import { one } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { shareLinkIndex } from "#db/schema/auth.ts";
import type { AclEntry } from "#db/schema/space.ts";
import { acl } from "#db/schema/space.ts";

export interface CreateShareLinkOptions {
  name: string;
  resourceType: ResourceType;
  resourceId: string;
  /** Required: nothing else retires a link. */
  expiresAt: Date;
  password?: string;
  createdBy: string;
}

/** Link metadata as the API reports it. */
export interface ShareLinkSummary {
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

export interface ValidateShareLinkResult {
  link: AclEntry;
  linkId: string;
  /** The caller must pass an HTTP Basic password before the link resolves. */
  requiresPassword: boolean;
}

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

/** The path a link is handed out as. */
export function shareLinkPath(linkId: string): string {
  return `/s/${linkId}`;
}

/** Mint a link scoped to one resource. */
export async function createShareLink(
  s: SpaceStore,
  options: CreateShareLinkOptions,
): Promise<{ id: string; path: string }> {
  const id = createId("shareLink");
  const now = new Date();

  await s.db.insert(acl).values({
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    userId: id,
    groupId: null,
    // Pinned, not defaulted: writes belong to a real user.
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

  // Written after the row, so an index entry never points at a link that is not
  // there; the reverse — a row no entry names — only costs that link its URL.
  await getAuthDb().insert(shareLinkIndex).values({
    id,
    spaceId: s.spaceId,
    createdAt: now,
  });

  await logAclChange(s, s.spaceId, {
    event: "acl_grant",
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    userId: id,
    permission: Permission.VIEWER,
    actorUserId: options.createdBy,
  });

  return { id, path: shareLinkPath(id) };
}

/** The link a share URL names. Null when absent, revoked or expired alike. */
export async function validateShareLink(
  s: SpaceStore,
  linkId: string,
): Promise<ValidateShareLinkResult | null> {
  const [row] = await s.db.select().from(acl).where(linkRow(linkId)).limit(1);

  if (!row?.userId || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  return {
    link: row,
    linkId: row.userId,
    requiresPassword: row.secret !== null,
  };
}

/**
 * The link a share URL names, found through the index — a URL names no space.
 *
 * An id that is not indexed is answered by that lookup alone, which is what
 * keeps an invented one from costing a read of every space in the instance.
 */
export async function findShareLink(
  linkId: string,
): Promise<(ValidateShareLinkResult & { spaceId: string }) | null> {
  // The share page is reached without a session, so this can be the request
  // that first touches the auth database.
  await initializeDatabases();

  const indexed = await one(
    getAuthDb().select().from(shareLinkIndex).where(eq(shareLinkIndex.id, linkId)),
  );
  if (!indexed) return null;

  // A space that is gone or disabled answers for its links too.
  if (!(await getIndexedSpace(indexed.spaceId))) return null;

  const result = await validateShareLink(await openSpaceStore(indexed.spaceId), linkId);
  return result && { ...result, spaceId: indexed.spaceId };
}

/** Verify the HTTP Basic password a protected link challenges for. */
export async function verifyShareLinkPassword(
  link: AclEntry,
  password: string,
): Promise<boolean> {
  if (!link.secret) return true;
  return await Bun.password.verify(password, link.secret);
}

/**
 * Proof that this link's password was accepted, for the cookie the page hands
 * back — the cookie is written by the client, so the link id in it says only
 * which link is claimed, never that its password was ever given.
 *
 * Signed over the password verifier, so changing or clearing the password
 * retires every proof outstanding for it. Null when there is no signing key:
 * a protected link then serves its page and nothing else, rather than trusting
 * an unsigned claim.
 */
export function shareLinkProof(link: AclEntry): string | null {
  if (!link.secret || !link.userId) return null;

  const key = config().AUTH_SECRET?.trim();
  if (!key) return null;

  return createHmac("sha256", key)
    .update(`share-link:${link.userId}:${link.secret}`)
    .digest("hex");
}

/**
 * Whether `proof` is this link's, in constant time. A link with no password
 * needs none: its URL is the whole credential.
 */
export function verifyShareLinkProof(link: AclEntry, proof: string | null): boolean {
  if (!link.secret) return true;

  const expected = shareLinkProof(link);
  if (!expected || !proof || proof.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
}

/** Records a use, once any password has been accepted. */
export async function markShareLinkUsed(s: SpaceStore, linkId: string): Promise<void> {
  await s.db.update(acl).set({ lastUsedAt: new Date() }).where(linkRow(linkId));
}

/** Every link in the space, or those on one resource at either page scope. */
export async function listShareLinks(
  s: SpaceStore,
  resource?: { resourceId: string; resourceTypes: ResourceType[] },
): Promise<ShareLinkSummary[]> {
  const rows = await s.db
    .select()
    .from(acl)
    .where(
      resource
        ? and(
            eq(acl.kind, AclKind.LINK),
            eq(acl.resourceId, resource.resourceId),
            inArray(acl.resourceType, resource.resourceTypes),
          )
        : eq(acl.kind, AclKind.LINK),
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

/** Revoke a link. The row and its grant stay, so this is reversible. */
export async function revokeShareLink(
  s: SpaceStore,
  linkId: string,
  actorUserId?: string,
): Promise<boolean> {
  const [previous] = await s.db.select().from(acl).where(linkRow(linkId)).limit(1);
  if (!previous) return false;

  await s.db
    .update(acl)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(linkRow(linkId));

  // Re-revoking succeeds but must not write a second audit entry.
  if (!previous.revokedAt) {
    await logAclChange(s, s.spaceId, {
      event: "acl_revoke",
      resourceType: previous.resourceType as ResourceType,
      resourceId: previous.resourceId,
      userId: linkId,
      previousPermission: previous.permission,
      actorUserId,
    });
  }

  return true;
}
