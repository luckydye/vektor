/**
 * Access tokens. A token is an `acl` row that carries a credential: same table,
 * same resolution, plus the columns needed to authenticate it. So a token is
 * scoped to exactly one resource — two scopes means two tokens — and deleting it
 * takes its grant with it rather than leaving one behind.
 *
 * What the row grants is a ceiling, not authority: resolution caps it at what
 * `createdBy` can still do (see `capRowsToIssuer`).
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { AclKind, Permission, ResourceType } from "#acl/permissions.ts";
import { hasPermission, logAclChange } from "#acl/store.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import type { AccessToken, AclEntry } from "#db/schema/space.ts";
import { acl } from "#db/schema/space.ts";
import { listAllSpaces, listUserSpaces } from "./spaces.ts";

/** Ten years: long enough for any standing credential, short enough to expire. */
export const MAX_ACCESS_TOKEN_EXPIRY_DAYS = 3650;

export interface CreateAccessTokenOptions {
  name: string;
  resourceType: ResourceType;
  resourceId: string;
  permission: string;
  expiresAt?: Date;
  createdBy: string;
}

/** What a token is scoped to, as the API reports it. */
export interface TokenResource {
  resourceType: string;
  resourceId: string;
  userId: string | null;
  permission: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Token metadata as the API reports it, without the secret. */
export interface AccessTokenSummary {
  id: string;
  name: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  createdBy: string | null;
  revokedAt: Date | null;
}

/** A token as its issuer sees it: which space it opens, and what it grants there. */
export interface PersonalAccessToken extends AccessTokenSummary {
  spaceId: string;
  spaceName: string;
  resources: TokenResource[];
}

export interface ValidateTokenResult {
  token: AccessToken;
  tokenId: string;
}

/**
 * Generate a cryptographically secure token
 * Format: at_<32 random hex characters>
 */
function generateToken(): string {
  const randomHex = randomBytes(32).toString("hex");
  return `at_${randomHex}`;
}

/** Hash a token's string for storage. */
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Matches the one row that is this token, and never a grant carrying no credential. */
function tokenRow(tokenId: string) {
  return and(eq(acl.userId, tokenId), eq(acl.kind, AclKind.TOKEN));
}

function toSummary(row: AclEntry): AccessTokenSummary {
  return {
    id: row.userId ?? "",
    name: row.name,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    revokedAt: row.revokedAt,
  };
}

/**
 * Mint a token scoped to one resource. The secret is returned once and only its
 * hash is stored.
 *
 * @example
 * ```ts
 * const { token, id } = await createAccessToken(store, {
 *   name: "CI/CD Pipeline",
 *   resourceType: ResourceType.DOCUMENT,
 *   resourceId: "doc456",
 *   permission: "editor",
 *   createdBy: "user789",
 * });
 * ```
 */
export async function createAccessToken(
  s: SpaceStore,
  options: CreateAccessTokenOptions,
): Promise<{ id: string; token: string }> {
  const token = generateToken();
  const id = createId("accessToken");
  const now = new Date();

  await s.db.insert(acl).values({
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    userId: id,
    groupId: null,
    permission: options.permission,
    createdAt: now,
    updatedAt: now,
    name: options.name,
    secret: hashSecret(token),
    kind: AclKind.TOKEN,
    expiresAt: options.expiresAt,
    lastUsedAt: null,
    createdBy: options.createdBy,
    revokedAt: null,
  });

  await logAclChange(s, s.spaceId, {
    event: "acl_grant",
    kind: AclKind.TOKEN,
    resourceType: options.resourceType,
    resourceId: options.resourceId,
    userId: id,
    permission: options.permission,
    actorUserId: options.createdBy,
  });

  return { id, token };
}

/**
 * Re-scope a token, or change what it grants.
 *
 * @example
 * ```ts
 * await grantTokenAccess(store, "token_abc123", ResourceType.DOCUMENT, "doc456", "editor");
 * ```
 */
export async function grantTokenAccess(
  s: SpaceStore,
  tokenId: string,
  resourceType: ResourceType,
  resourceId: string,
  permission: string,
  actorUserId?: string,
): Promise<boolean> {
  // Read first so the audit entry can say what the grant moved away from.
  const [previous] = await s.db.select().from(acl).where(tokenRow(tokenId)).limit(1);
  if (!previous) return false;

  await s.db
    .update(acl)
    .set({ resourceType, resourceId, permission, updatedAt: new Date() })
    .where(tokenRow(tokenId));

  const rescoped =
    previous.resourceType !== resourceType || previous.resourceId !== resourceId;

  // A re-scope takes access away from the old resource, so log it there too —
  // otherwise the document that lost the token shows no trace of it.
  if (rescoped) {
    await logAclChange(s, s.spaceId, {
      event: "acl_revoke",
      kind: AclKind.TOKEN,
      resourceType: previous.resourceType as ResourceType,
      resourceId: previous.resourceId,
      userId: tokenId,
      previousPermission: previous.permission,
      actorUserId,
    });
  }

  if (rescoped || previous.permission !== permission) {
    await logAclChange(s, s.spaceId, {
      event: "acl_grant",
      kind: AclKind.TOKEN,
      resourceType,
      resourceId,
      userId: tokenId,
      permission,
      previousPermission: rescoped ? undefined : previous.permission,
      actorUserId,
    });
  }

  return true;
}

/**
 * The resource a token is scoped to, at the level it was granted. That level is
 * a ceiling, so this can read higher than the token's effective authority.
 */
export async function listTokenResources(
  s: SpaceStore,
  tokenId: string,
  resourceType?: ResourceType,
): Promise<TokenResource[]> {
  // Selected column by column: the row also carries the secret's hash, which
  // must not travel with the grant it is attached to.
  const rows = await s.db
    .select({
      resourceType: acl.resourceType,
      resourceId: acl.resourceId,
      userId: acl.userId,
      permission: acl.permission,
      createdAt: acl.createdAt,
      updatedAt: acl.updatedAt,
    })
    .from(acl)
    .where(tokenRow(tokenId));

  return rows.filter((row) => !resourceType || row.resourceType === resourceType);
}

/**
 * Validate an access token and return its details
 * Returns null if token is invalid, revoked, or expired
 *
 * @example
 * ```ts
 * const result = await validateAccessToken(store, "at_abc123...");
 * ```
 */
export async function validateAccessToken(
  s: SpaceStore,
  token: string,
): Promise<ValidateTokenResult | null> {
  const [result] = await s.db
    .select()
    .from(acl)
    .where(
      and(
        eq(acl.secret, hashSecret(token)),
        eq(acl.kind, AclKind.TOKEN),
        isNull(acl.revokedAt),
      ),
    )
    .limit(1);

  if (!result?.secret || !result.createdBy || !result.userId) {
    return null;
  }

  // Check expiration
  if (result.expiresAt && result.expiresAt < new Date()) {
    return null;
  }

  const tokenId = result.userId;

  // Access tokens are delegations made by a space member, not independent
  // service accounts. If the creator no longer belongs to the space, revoke
  // the credential permanently so re-adding the user cannot revive a secret
  // that remained on an offboarded user's machine.
  const creatorStillBelongsToSpace = await hasPermission(
    s.spaceId,
    ResourceType.SPACE,
    s.spaceId,
    result.createdBy,
    Permission.VIEWER,
    await getUserGroups(result.createdBy),
  );
  if (!creatorStillBelongsToSpace) {
    await revokeAccessToken(s, tokenId);
    return null;
  }

  await s.db.update(acl).set({ lastUsedAt: new Date() }).where(tokenRow(tokenId));

  return {
    token: { ...result, secret: result.secret, createdBy: result.createdBy },
    tokenId,
  };
}

/**
 * Revoke an access token (soft delete)
 * The row and its grant stay; the secret stops authenticating.
 *
 * @example
 * ```ts
 * await revokeAccessToken(store, "token_abc123");
 * ```
 */
export async function revokeAccessToken(
  s: SpaceStore,
  tokenId: string,
  actorUserId?: string,
): Promise<boolean> {
  // Read first: `returning()` hands back the row after the update, which cannot
  // tell an already-revoked token from a freshly revoked one. Re-revoking stays
  // a success for the caller, but must not write a second audit entry.
  const [previous] = await s.db.select().from(acl).where(tokenRow(tokenId)).limit(1);
  if (!previous) return false;

  await s.db
    .update(acl)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(tokenRow(tokenId));

  if (!previous.revokedAt) {
    await logAclChange(s, s.spaceId, {
      event: "acl_revoke",
      kind: AclKind.TOKEN,
      resourceType: previous.resourceType as ResourceType,
      resourceId: previous.resourceId,
      userId: tokenId,
      previousPermission: previous.permission,
      actorUserId,
    });
  }

  return true;
}

/**
 * List all access tokens for a space
 * Returns tokens without the actual token value (only metadata)
 */
export async function listAccessTokens(s: SpaceStore): Promise<AccessTokenSummary[]> {
  const rows = await s.db.select().from(acl).where(eq(acl.kind, AclKind.TOKEN));
  return rows.map(toSummary);
}

/**
 * Get a single access token by ID
 * Returns token metadata without the actual token value
 */
export async function getAccessToken(
  s: SpaceStore,
  tokenId: string,
): Promise<AccessTokenSummary | null> {
  const [row] = await s.db.select().from(acl).where(tokenRow(tokenId)).limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Whether a credential holds a grant under this id. Any kind of credential, and
 * revoked ones included: the question is what the principal is, not what it may
 * currently do — asked to tell a caller apart, never to decide access.
 */
export async function hasCredentialGrant(
  s: SpaceStore,
  principalId: string,
): Promise<boolean> {
  const [row] = await s.db
    .select({ kind: acl.kind })
    .from(acl)
    .where(and(eq(acl.userId, principalId), isNotNull(acl.kind)))
    .limit(1);

  return row !== undefined;
}

/**
 * The tokens this user minted in this space. Tokens issued by anyone else stay
 * out: this is the issuer's own listing, not the space's.
 */
export async function listAccessTokensCreatedBy(
  s: SpaceStore,
  userId: string,
): Promise<AccessTokenSummary[]> {
  const rows = await s.db
    .select()
    .from(acl)
    .where(and(eq(acl.kind, AclKind.TOKEN), eq(acl.createdBy, userId)));
  return rows.map(toSummary);
}

/**
 * Every token this user issued, across the spaces they still belong to. A token
 * in a space they have left is left out — it no longer authenticates anyway,
 * since resolution caps it at what its issuer can still do.
 */
export async function listPersonalAccessTokens(
  userId: string,
): Promise<PersonalAccessToken[]> {
  const tokens: PersonalAccessToken[] = [];

  for (const space of await listUserSpaces(userId)) {
    const store = await openSpaceStore(space.id);
    for (const token of await listAccessTokensCreatedBy(store, userId)) {
      tokens.push({
        ...token,
        spaceId: space.id,
        spaceName: space.name,
        resources: await listTokenResources(store, token.id),
      });
    }
  }

  return tokens.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * The space holding a token this user issued. Null when no such token exists,
 * which is also the answer for someone else's token — the caller may only reach
 * its own.
 */
export async function findPersonalTokenSpace(
  userId: string,
  tokenId: string,
): Promise<string | null> {
  for (const space of await listUserSpaces(userId)) {
    const token = await getAccessToken(await openSpaceStore(space.id), tokenId);
    if (token?.createdBy === userId) return space.id;
  }
  return null;
}

/**
 * Find which space a raw token belongs to by scanning all spaces.
 * Returns the s.spaceId if found and valid, null otherwise.
 */
export async function findSpaceForToken(token: string): Promise<string | null> {
  const spaces = await listAllSpaces();
  for (const space of spaces) {
    const spaceStore = await openSpaceStore(space.id);
    if (await validateAccessToken(spaceStore, token)) return space.id;
  }
  return null;
}

/**
 * Delete an access token permanently. The row is the token, so its grant goes
 * with it — there is nothing left to reference it.
 *
 * @example
 * ```ts
 * await deleteAccessToken(store, "token_abc123");
 * ```
 */
export async function deleteAccessToken(
  s: SpaceStore,
  tokenId: string,
  actorUserId?: string,
): Promise<boolean> {
  const [deleted] = await s.db.delete(acl).where(tokenRow(tokenId)).returning();
  if (!deleted) return false;

  // Already-revoked tokens logged their revoke when it happened; deleting one
  // removes the grant that is no longer there to remove.
  if (!deleted.revokedAt) {
    await logAclChange(s, s.spaceId, {
      event: "acl_revoke",
      kind: AclKind.TOKEN,
      resourceType: deleted.resourceType as ResourceType,
      resourceId: deleted.resourceId,
      userId: tokenId,
      previousPermission: deleted.permission,
      actorUserId,
    });
  }

  return true;
}
