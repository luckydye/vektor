import { and, eq, like } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { extensionStorage } from "./schema/space.ts";

export interface StorageEntry {
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get a value from extension storage
 */
export async function getStorageValue(
  spaceId: string,
  extensionId: string,
  key: string,
): Promise<string | null> {
  const db = await getSpaceDb(spaceId);
  const result = await db
    .select({ value: extensionStorage.value })
    .from(extensionStorage)
    .where(
      and(eq(extensionStorage.extensionId, extensionId), eq(extensionStorage.key, key)),
    )
    .get();

  return result?.value ?? null;
}

/**
 * Set a value in extension storage (upsert)
 */
export async function setStorageValue(
  spaceId: string,
  extensionId: string,
  key: string,
  value: string,
): Promise<StorageEntry> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  const existing = await db
    .select({ id: extensionStorage.id })
    .from(extensionStorage)
    .where(
      and(eq(extensionStorage.extensionId, extensionId), eq(extensionStorage.key, key)),
    )
    .get();

  if (existing) {
    await db
      .update(extensionStorage)
      .set({ value, updatedAt: now })
      .where(eq(extensionStorage.id, existing.id));
  } else {
    await db.insert(extensionStorage).values({
      id: crypto.randomUUID(),
      extensionId,
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    key,
    value,
    createdAt: existing ? now : now,
    updatedAt: now,
  };
}

/**
 * Delete a value from extension storage
 */
export async function deleteStorageValue(
  spaceId: string,
  extensionId: string,
  key: string,
): Promise<boolean> {
  const db = await getSpaceDb(spaceId);
  const result = await db
    .delete(extensionStorage)
    .where(
      and(eq(extensionStorage.extensionId, extensionId), eq(extensionStorage.key, key)),
    );

  return result.rowsAffected > 0;
}

/**
 * List all storage entries for an extension, optionally filtered by key prefix
 */
export async function listStorageEntries(
  spaceId: string,
  extensionId: string,
  prefix?: string,
): Promise<StorageEntry[]> {
  const db = await getSpaceDb(spaceId);

  const conditions = [eq(extensionStorage.extensionId, extensionId)];
  if (prefix) {
    conditions.push(like(extensionStorage.key, `${prefix}%`));
  }

  const results = await db
    .select({
      key: extensionStorage.key,
      value: extensionStorage.value,
      createdAt: extensionStorage.createdAt,
      updatedAt: extensionStorage.updatedAt,
    })
    .from(extensionStorage)
    .where(and(...conditions));

  return results;
}

/**
 * Delete all storage entries for an extension
 */
export async function clearExtensionStorage(
  spaceId: string,
  extensionId: string,
): Promise<number> {
  const db = await getSpaceDb(spaceId);
  const result = await db
    .delete(extensionStorage)
    .where(eq(extensionStorage.extensionId, extensionId));

  return result.rowsAffected;
}
