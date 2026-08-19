import { eq } from "drizzle-orm";
import { canAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { spaceSecret } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";

export type SpaceSecretMetadata = {
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

const SPACE_SECRET_NAMESPACE_SEPARATOR = ":";

export const spaceSecretNamespaces = {
  secrets: "secrets",
} as const;

/** A key owned by application code rather than the user-facing secret store. */
export function spaceSecretKey(namespace: string, name: string): string {
  return `${namespace}${SPACE_SECRET_NAMESPACE_SEPARATOR}${name}`;
}

/**
 * Namespaced secrets are application-owned and must never be addressable through
 * the generic secrets API. Double-underscore names were the old internal-secret
 * convention and remain reserved so existing rows cannot become visible again.
 */
function isUserManagedSecretName(name: string): boolean {
  return !name.includes(SPACE_SECRET_NAMESPACE_SEPARATOR) && !name.startsWith("__");
}

export function sanitizeSecretName(value: string): string {
  const name = value.trim();
  if (!name) {
    throw new Error("Secret name is required");
  }
  if (name.length > 128) {
    throw new Error("Secret name must be <= 128 characters");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("Secret name may only contain letters, numbers, '.', '_' and '-'");
  }
  if (!isUserManagedSecretName(name)) {
    throw new Error("Secret name is reserved for internal use");
  }
  return name;
}

export async function listSpaceSecrets(s: SpaceStore): Promise<SpaceSecretMetadata[]> {
  const rows = await s.db
    .select({
      name: spaceSecret.name,
      description: spaceSecret.description,
      createdBy: spaceSecret.createdBy,
      createdAt: spaceSecret.createdAt,
      updatedAt: spaceSecret.updatedAt,
      lastUsedAt: spaceSecret.lastUsedAt,
    })
    .from(spaceSecret);

  return rows
    .filter((row) => isUserManagedSecretName(row.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertSpaceSecret(
  s: SpaceStore,
  name: string,
  value: string,
  createdBy: string,
  description?: string | null,
): Promise<SpaceSecretMetadata> {
  if (!isUserManagedSecretName(name)) {
    throw new Error("Secret name is reserved for internal use");
  }

  const existing = await one(
    s.db.select().from(spaceSecret).where(eq(spaceSecret.name, name)).limit(1),
  );

  const now = new Date();
  const encrypted = encryptSecret(value);

  if (existing) {
    await s.db
      .update(spaceSecret)
      .set({
        description: description ?? null,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        updatedAt: now,
      })
      .where(eq(spaceSecret.id, existing.id));

    return {
      name,
      description: description ?? null,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      updatedAt: now,
      lastUsedAt: existing.lastUsedAt,
    };
  }

  await s.db.insert(spaceSecret).values({
    id: createId("secret"),
    name,
    description: description ?? null,
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    createdBy,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  });

  return {
    name,
    description: description ?? null,
    createdBy,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
}

export async function getSpaceSecretValue(
  s: SpaceStore,
  name: string,
): Promise<string | null> {
  const row = await one(
    s.db.select().from(spaceSecret).where(eq(spaceSecret.name, name)).limit(1),
  );

  if (!row) {
    return null;
  }

  await s.db
    .update(spaceSecret)
    .set({
      lastUsedAt: new Date(),
    })
    .where(eq(spaceSecret.id, row.id));

  return decryptSecret({
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
  });
}

export async function deleteSpaceSecret(s: SpaceStore, name: string): Promise<boolean> {
  if (!isUserManagedSecretName(name)) {
    return false;
  }

  const result = await s.db
    .delete(spaceSecret)
    .where(eq(spaceSecret.name, name))
    .returning({ id: spaceSecret.id });
  return result.length > 0;
}

export async function userCanReadSpaceSecret(
  s: SpaceStore,
  name: string,
  userId: string,
): Promise<boolean> {
  if (!isUserManagedSecretName(name)) {
    return false;
  }

  return canAccess(
    s.spaceId,
    { type: ResourceType.SPACE, id: s.spaceId },
    userId,
    Permission.OWNER,
  );
}

export async function getSpaceSecretValueForUser(
  s: SpaceStore,
  name: string,
  userId: string,
): Promise<string | null> {
  const allowed = await userCanReadSpaceSecret(s, name, userId);
  if (!allowed) {
    return null;
  }

  return getSpaceSecretValue(s, name);
}

export async function hasSpaceSecret(s: SpaceStore, name: string): Promise<boolean> {
  if (!isUserManagedSecretName(name)) {
    return false;
  }

  const row = await one(
    s.db
      .select({ name: spaceSecret.name })
      .from(spaceSecret)
      .where(eq(spaceSecret.name, name))
      .limit(1),
  );

  return !!row;
}

export async function getSpaceSecretMetadata(
  s: SpaceStore,
  name: string,
): Promise<SpaceSecretMetadata | null> {
  if (!isUserManagedSecretName(name)) {
    return null;
  }

  const row = await one(
    s.db
      .select({
        name: spaceSecret.name,
        description: spaceSecret.description,
        createdBy: spaceSecret.createdBy,
        createdAt: spaceSecret.createdAt,
        updatedAt: spaceSecret.updatedAt,
        lastUsedAt: spaceSecret.lastUsedAt,
      })
      .from(spaceSecret)
      .where(eq(spaceSecret.name, name))
      .limit(1),
  );

  return row ?? null;
}
