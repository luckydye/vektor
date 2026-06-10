import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { isInMemoryDb } from "../inMemoryDb.ts";
import { initSpaceDbSchema, prepareSpaceDb, prepateAuthDb } from "./init.ts";
import * as schema from "./schema.ts";

const DATA_DIR = "./data";
const AUTH_DB_PATH = join(DATA_DIR, "auth.db");

function createAuthDb() {
  if (isInMemoryDb()) {
    return drizzle({
      connection: { source: ":memory:", create: true, readwrite: true },
    });
  }

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  return drizzle({
    connection: {
      source: path.resolve(AUTH_DB_PATH),
      create: true,
      readwrite: true,
    },
  });
}

const authDb = createAuthDb();
prepateAuthDb(authDb);

export function getAuthDb() {
  return authDb;
}

const spaceDbCache = new Map<string, ReturnType<typeof drizzle>>();
const spaceDbPreparation = new Map<string, Promise<void>>();

export async function getSpaceDb(spaceId: string) {
  const cached = spaceDbCache.get(spaceId);
  if (cached) {
    return cached;
  }

  if (isInMemoryDb()) {
    // Each in-memory space database is a distinct SQLite instance kept alive
    // by the cache. Schema is applied immediately on first access.
    let preparation = spaceDbPreparation.get(spaceId);
    if (!preparation) {
      const spaceDb = drizzle({
        connection: { source: ":memory:", create: true, readwrite: true },
      });
      spaceDbCache.set(spaceId, spaceDb);
      preparation = initSpaceDbSchema(spaceDb);
      spaceDbPreparation.set(spaceId, preparation);
    }
    await preparation;
    return spaceDbCache.get(spaceId)!;
  }

  let preparation = spaceDbPreparation.get(spaceId);
  if (!preparation) {
    preparation = prepareSpaceDb(spaceId);
    spaceDbPreparation.set(spaceId, preparation);
  }
  await preparation;

  const spaceDir = join(DATA_DIR, "spaces");

  if (!existsSync(spaceDir)) {
    mkdirSync(spaceDir, { recursive: true });
  }

  const spaceDb = drizzle({
    connection: {
      source: path.resolve(spaceDir, `${spaceId}.db`),
      create: true,
      readwrite: true,
    },
  });

  spaceDbCache.set(spaceId, spaceDb);

  return spaceDb;
}

export function closeSpaceDb(spaceId: string) {
  if (spaceDbCache.has(spaceId)) {
    spaceDbCache.delete(spaceId);
  }
}

/** Returns the IDs of all spaces currently registered in the in-memory cache. */
export function listInMemorySpaceIds(): string[] {
  return Array.from(spaceDbCache.keys());
}

export { schema };
