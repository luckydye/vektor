import { and, eq, lt } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { oauthIntegration, oauthIntegrationState } from "./schema/space.ts";
import { decryptSecret, encryptSecret } from "./secretsCrypto.ts";

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

export interface OAuthIntegrationCredential extends OAuthIntegrationConnection {
  accessToken: string;
  refreshToken: string | null;
}

function rowToConnection(
  row: typeof oauthIntegration.$inferSelect,
): OAuthIntegrationConnection {
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

export async function listOAuthIntegrationsForUser(
  spaceId: string,
  userId: string,
): Promise<OAuthIntegrationConnection[]> {
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select()
    .from(oauthIntegration)
    .where(eq(oauthIntegration.userId, userId));

  return rows.map(rowToConnection);
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
    .where(
      and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)),
    )
    .limit(1)
    .get();

  return row ? rowToConnection(row) : null;
}

export async function getOAuthIntegrationCredentialForUser(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<OAuthIntegrationCredential | null> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select()
    .from(oauthIntegration)
    .where(
      and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)),
    )
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  const now = new Date();
  await db
    .update(oauthIntegration)
    .set({ lastUsedAt: now })
    .where(eq(oauthIntegration.id, row.id));

  return {
    ...rowToConnection(row),
    lastUsedAt: now,
    accessToken: decryptSecret({
      ciphertext: row.accessTokenCiphertext,
      iv: row.accessTokenIv,
      authTag: row.accessTokenAuthTag,
    }),
    refreshToken:
      row.refreshTokenCiphertext && row.refreshTokenIv && row.refreshTokenAuthTag
        ? decryptSecret({
            ciphertext: row.refreshTokenCiphertext,
            iv: row.refreshTokenIv,
            authTag: row.refreshTokenAuthTag,
          })
        : null,
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
    .where(
      and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)),
    )
    .limit(1)
    .get();

  const now = new Date();
  const accessEncrypted = encryptSecret(tokenSet.accessToken);
  const refreshEncrypted = tokenSet.refreshToken
    ? encryptSecret(tokenSet.refreshToken)
    : null;

  const connectionBase = {
    provider,
    userId,
    externalAccountId,
    externalUsername,
    instanceUrl,
    scope: tokenSet.scope,
    accessTokenExpiresAt: tokenSet.expiresAt,
    updatedAt: now,
  };

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
      ...connectionBase,
      id: existing.id,
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt ?? null,
    };
  }

  const id = createId("oauthIntegration");
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
    ...connectionBase,
    id,
    createdAt: now,
    lastUsedAt: null,
  };
}

export async function updateOAuthIntegrationTokenSet(
  spaceId: string,
  integrationId: string,
  tokenSet: OAuthIntegrationTokenSet,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const accessEncrypted = encryptSecret(tokenSet.accessToken);
  const refreshEncrypted = tokenSet.refreshToken
    ? encryptSecret(tokenSet.refreshToken)
    : null;

  await db
    .update(oauthIntegration)
    .set({
      accessTokenCiphertext: accessEncrypted.ciphertext,
      accessTokenIv: accessEncrypted.iv,
      accessTokenAuthTag: accessEncrypted.authTag,
      refreshTokenCiphertext: refreshEncrypted?.ciphertext ?? null,
      refreshTokenIv: refreshEncrypted?.iv ?? null,
      refreshTokenAuthTag: refreshEncrypted?.authTag ?? null,
      accessTokenExpiresAt: tokenSet.expiresAt,
      scope: tokenSet.scope,
      updatedAt: new Date(),
    })
    .where(eq(oauthIntegration.id, integrationId));
}

export async function deleteOAuthIntegrationForUser(
  spaceId: string,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const result = await db
    .delete(oauthIntegration)
    .where(
      and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)),
    );
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
    .where(
      and(
        eq(oauthIntegrationState.userId, userId),
        eq(oauthIntegrationState.provider, provider),
      ),
    );
  await db.delete(oauthIntegrationState).where(lt(oauthIntegrationState.expiresAt, now));

  await db.insert(oauthIntegrationState).values({
    id: createId("oauthIntegrationState"),
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
): Promise<{
  codeVerifier: string;
  redirectTo: string | null;
  instanceUrl: string | null;
} | null> {
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
