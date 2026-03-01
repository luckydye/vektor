import { and, eq, lt } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { encryptSecret } from "./secretsCrypto.ts";
import { oauthIntegration, oauthIntegrationState } from "./schema/space.ts";

export type OAuthIntegrationProvider = "gitlab" | "youtrack";

export interface OAuthIntegrationConnection {
  id: string;
  provider: OAuthIntegrationProvider;
  userId: string;
  externalAccountId: string;
  externalUsername: string | null;
  instanceUrl: string | null;
  scope: string | null;
  accessTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export interface OAuthIntegrationTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export async function listOAuthIntegrationsForUser(
  spaceId: string,
  userId: string,
): Promise<OAuthIntegrationConnection[]> {
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select()
    .from(oauthIntegration)
    .where(eq(oauthIntegration.userId, userId));

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider as OAuthIntegrationProvider,
    userId: row.userId,
    externalAccountId: row.externalAccountId,
    externalUsername: row.externalUsername ?? null,
    instanceUrl: row.instanceUrl ?? null,
    scope: row.scope ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? null,
  }));
}

export async function getOAuthIntegrationForUser(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<OAuthIntegrationConnection | null> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select()
    .from(oauthIntegration)
    .where(and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)))
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    provider: row.provider as OAuthIntegrationProvider,
    userId: row.userId,
    externalAccountId: row.externalAccountId,
    externalUsername: row.externalUsername ?? null,
    instanceUrl: row.instanceUrl ?? null,
    scope: row.scope ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

export async function upsertOAuthIntegrationForUser(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
  externalAccountId: string,
  externalUsername: string | null,
  instanceUrl: string | null,
  tokenSet: OAuthIntegrationTokenSet,
): Promise<OAuthIntegrationConnection> {
  const db = await getSpaceDb(spaceId);
  const existing = await db
    .select()
    .from(oauthIntegration)
    .where(and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)))
    .limit(1)
    .get();

  const now = new Date();
  const accessEncrypted = encryptSecret(tokenSet.accessToken);
  const refreshEncrypted = tokenSet.refreshToken
    ? encryptSecret(tokenSet.refreshToken)
    : null;

  if (existing) {
    await db
      .update(oauthIntegration)
      .set({
        externalAccountId,
        externalUsername,
        instanceUrl,
        scope: tokenSet.scope,
        accessTokenCiphertext: accessEncrypted.ciphertext,
        accessTokenIv: accessEncrypted.iv,
        accessTokenAuthTag: accessEncrypted.authTag,
        refreshTokenCiphertext: refreshEncrypted?.ciphertext ?? null,
        refreshTokenIv: refreshEncrypted?.iv ?? null,
        refreshTokenAuthTag: refreshEncrypted?.authTag ?? null,
        accessTokenExpiresAt: tokenSet.expiresAt,
        updatedAt: now,
      })
      .where(eq(oauthIntegration.id, existing.id));

    return {
      id: existing.id,
      provider,
      userId,
      externalAccountId,
      externalUsername,
      instanceUrl,
      scope: tokenSet.scope,
      accessTokenExpiresAt: tokenSet.expiresAt,
      createdAt: existing.createdAt,
      updatedAt: now,
      lastUsedAt: existing.lastUsedAt ?? null,
    };
  }

  const id = crypto.randomUUID();
  await db.insert(oauthIntegration).values({
    id,
    provider,
    userId,
    externalAccountId,
    externalUsername,
    instanceUrl,
    scope: tokenSet.scope,
    accessTokenCiphertext: accessEncrypted.ciphertext,
    accessTokenIv: accessEncrypted.iv,
    accessTokenAuthTag: accessEncrypted.authTag,
    refreshTokenCiphertext: refreshEncrypted?.ciphertext ?? null,
    refreshTokenIv: refreshEncrypted?.iv ?? null,
    refreshTokenAuthTag: refreshEncrypted?.authTag ?? null,
    accessTokenExpiresAt: tokenSet.expiresAt,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  });

  return {
    id,
    provider,
    userId,
    externalAccountId,
    externalUsername,
    instanceUrl,
    scope: tokenSet.scope,
    accessTokenExpiresAt: tokenSet.expiresAt,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
}

export async function deleteOAuthIntegrationForUser(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const result = await db
    .delete(oauthIntegration)
    .where(and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)));
  return result.rowsAffected > 0;
}

export async function createOAuthIntegrationState(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
  state: string,
  codeVerifier: string,
  redirectTo: string | null,
  instanceUrl: string | null,
  ttlMs = 10 * 60 * 1000,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await db
    .delete(oauthIntegrationState)
    .where(and(eq(oauthIntegrationState.userId, userId), eq(oauthIntegrationState.provider, provider)));
  await db.delete(oauthIntegrationState).where(lt(oauthIntegrationState.expiresAt, now));

  await db.insert(oauthIntegrationState).values({
    id: crypto.randomUUID(),
    state,
    provider,
    userId,
    codeVerifier,
    redirectTo,
    instanceUrl,
    createdAt: now,
    expiresAt,
  });
}

export async function consumeOAuthIntegrationState(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
  state: string,
): Promise<
  { codeVerifier: string; redirectTo: string | null; instanceUrl: string | null } | null
> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  const row = await db
    .select()
    .from(oauthIntegrationState)
    .where(
      and(
        eq(oauthIntegrationState.state, state),
        eq(oauthIntegrationState.userId, userId),
        eq(oauthIntegrationState.provider, provider),
      ),
    )
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  await db.delete(oauthIntegrationState).where(eq(oauthIntegrationState.id, row.id));

  if (row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return {
    codeVerifier: row.codeVerifier,
    redirectTo: row.redirectTo ?? null,
    instanceUrl: row.instanceUrl ?? null,
  };
}
