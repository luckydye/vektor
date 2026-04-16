import { eq } from "drizzle-orm";
import { Permission, ResourceType, getUserGroups, hasPermission } from "./acl.ts";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { spaceSecret } from "./schema/space.ts";
import { decryptSecret, encryptSecret } from "./secretsCrypto.ts";
import { getSpace } from "./spaces.ts";

export type SpaceSecretMetadata = {
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
};

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
  return name;
}

export async function listSpaceSecrets(spaceId: string): Promise<SpaceSecretMetadata[]> {
  const db = await getSpaceDb(spaceId);
  const rows = await db
    .select({
      name: spaceSecret.name,
      description: spaceSecret.description,
      createdBy: spaceSecret.createdBy,
      createdAt: spaceSecret.createdAt,
      updatedAt: spaceSecret.updatedAt,
      lastUsedAt: spaceSecret.lastUsedAt,
    })
    .from(spaceSecret);

  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertSpaceSecret(
  spaceId: string,
  name: string,
  value: string,
  createdBy: string,
  description?: string | null,
): Promise<SpaceSecretMetadata> {
  const db = await getSpaceDb(spaceId);
  const existing = await db
    .select()
    .from(spaceSecret)
    .where(eq(spaceSecret.name, name))
    .limit(1)
    .get();

  const now = new Date();
  const encrypted = encryptSecret(value);

  if (existing) {
    await db
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

  await db.insert(spaceSecret).values({
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
  spaceId: string,
  name: string,
): Promise<string | null> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select()
    .from(spaceSecret)
    .where(eq(spaceSecret.name, name))
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  await db
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

export async function deleteSpaceSecret(spaceId: string, name: string): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const result = await db.delete(spaceSecret).where(eq(spaceSecret.name, name));
  return result.rowsAffected > 0;
}

export async function userCanReadSpaceSecret(
  spaceId: string,
  name: string,
  userId: string,
): Promise<boolean> {
  const space = await getSpace(spaceId);
  if (!space) {
    return false;
  }

  const groups = await getUserGroups(userId);
  if (space.createdBy === userId) {
    return true;
  }

  const isSpaceEditor = await hasPermission(
    spaceId,
    ResourceType.SPACE,
    spaceId,
    userId,
    Permission.EDITOR,
    groups,
  );
  if (isSpaceEditor) {
    return true;
  }

  return hasPermission(
    spaceId,
    ResourceType.SECRET,
    name,
    userId,
    Permission.VIEWER,
    groups,
  );
}

export async function getSpaceSecretValueForUser(
  spaceId: string,
  name: string,
  userId: string,
): Promise<string | null> {
  const allowed = await userCanReadSpaceSecret(spaceId, name, userId);
  if (!allowed) {
    return null;
  }

  return getSpaceSecretValue(spaceId, name);
}

export async function hasSpaceSecret(spaceId: string, name: string): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select({ name: spaceSecret.name })
    .from(spaceSecret)
    .where(eq(spaceSecret.name, name))
    .limit(1)
    .get();

  return !!row;
}

export async function getSpaceSecretMetadata(
  spaceId: string,
  name: string,
): Promise<SpaceSecretMetadata | null> {
  const db = await getSpaceDb(spaceId);
  const row = await db
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
    .limit(1)
    .get();

  return row ?? null;
}
