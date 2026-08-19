import { and, eq, lt } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { oauthIntegration, oauthIntegrationState } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";

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
  s: SpaceStore,
  userId: string,
): Promise<OAuthIntegrationConnection[]> {
  const rows = await s.db
    .select()
    .from(oauthIntegration)
    .where(eq(oauthIntegration.userId, userId));

  return rows.map(rowToConnection);
}

export async function getOAuthIntegrationForUser(
  s: SpaceStore,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<OAuthIntegrationConnection | null> {
  const row = await s.db
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
  s: SpaceStore,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<OAuthIntegrationCredential | null> {
  const row = await s.db
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
  await s.db
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
  s: SpaceStore,
  userId: string,
  provider: OAuthIntegrationProvider,
  externalAccountId: string,
  externalUsername: string | null,
  instanceUrl: string | null,
  tokenSet: OAuthIntegrationTokenSet,
): Promise<OAuthIntegrationConnection> {
  const existing = await s.db
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
    await s.db
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
  await s.db.insert(oauthIntegration).values({
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
  s: SpaceStore,
  integrationId: string,
  tokenSet: OAuthIntegrationTokenSet,
): Promise<void> {
  const accessEncrypted = encryptSecret(tokenSet.accessToken);
  const refreshEncrypted = tokenSet.refreshToken
    ? encryptSecret(tokenSet.refreshToken)
    : null;

  await s.db
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
  s: SpaceStore,
  userId: string,
  provider: OAuthIntegrationProvider,
): Promise<boolean> {
  const result = await s.db
    .delete(oauthIntegration)
    .where(
      and(eq(oauthIntegration.userId, userId), eq(oauthIntegration.provider, provider)),
    )
    .returning({ id: oauthIntegration.id });
  return result.length > 0;
}

export async function createOAuthIntegrationState(
  s: SpaceStore,
  userId: string,
  provider: OAuthIntegrationProvider,
  state: string,
  codeVerifier: string,
  redirectTo: string | null,
  instanceUrl: string | null,
  ttlMs = 10 * 60 * 1000,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  await s.db
    .delete(oauthIntegrationState)
    .where(
      and(
        eq(oauthIntegrationState.userId, userId),
        eq(oauthIntegrationState.provider, provider),
      ),
    );
  await s.db
    .delete(oauthIntegrationState)
    .where(lt(oauthIntegrationState.expiresAt, now));

  await s.db.insert(oauthIntegrationState).values({
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
  s: SpaceStore,
  userId: string,
  provider: OAuthIntegrationProvider,
  state: string,
): Promise<{
  codeVerifier: string;
  redirectTo: string | null;
  instanceUrl: string | null;
} | null> {
  const now = new Date();

  const row = await s.db
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

  await s.db.delete(oauthIntegrationState).where(eq(oauthIntegrationState.id, row.id));

  if (row.expiresAt.getTime() <= now.getTime()) {
    return null;
  }

  return {
    codeVerifier: row.codeVerifier,
    redirectTo: row.redirectTo ?? null,
    instanceUrl: row.instanceUrl ?? null,
  };
}
