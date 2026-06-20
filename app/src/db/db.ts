import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { isInMemoryDb } from "../inMemoryDb.ts";
import { applySpaceDbPragmas, initSpaceDbSchema, prepareSpaceDb, prepateAuthDb } from "./init.ts";
import * as schema from "./schema.ts";

const DATA_DIR = "./data";
const AUTH_DB_PATH = join(DATA_DIR, "auth.db");

type DrizzleDb = ReturnType<typeof drizzle>;

// When running in-memory, pin singletons on globalThis so the compiled Astro
// SSR bundle (which inlines its own copy of this module) shares the same
// instances rather than creating isolated duplicates.
declare global {
  // biome-ignore lint/style/noVar: globalThis augmentation requires var
  var __vektor_auth_db: DrizzleDb | undefined;
  // biome-ignore lint/style/noVar: globalThis augmentation requires var
  var __vektor_space_db_cache: Map<string, DrizzleDb> | undefined;
  // biome-ignore lint/style/noVar: globalThis augmentation requires var
  var __vektor_space_db_preparation: Map<string, Promise<void>> | undefined;
}

function createAuthDb() {
  if (isInMemoryDb()) {
    if (!globalThis.__vektor_auth_db) {
      const db = drizzle({
        connection: { source: ":memory:", create: true, readwrite: true },
      });
      prepateAuthDb(db);
      globalThis.__vektor_auth_db = db;
    }
    return globalThis.__vektor_auth_db;
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
if (!isInMemoryDb()) prepateAuthDb(authDb);

export function getAuthDb() {
  return authDb;
}

const spaceDbCache: Map<string, DrizzleDb> = (() => {
  if (isInMemoryDb()) {
    if (!globalThis.__vektor_space_db_cache) {
      globalThis.__vektor_space_db_cache = new Map();
    }
    return globalThis.__vektor_space_db_cache;
  }
  return new Map();
})();

const spaceDbPreparation: Map<string, Promise<void>> = (() => {
  if (isInMemoryDb()) {
    if (!globalThis.__vektor_space_db_preparation) {
      globalThis.__vektor_space_db_preparation = new Map();
    }
    return globalThis.__vektor_space_db_preparation;
  }
  return new Map();
})();

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

  // Cache before awaiting so concurrent first-requests reuse this connection
  // instead of each creating their own and racing on PRAGMA journal_mode.
  spaceDbCache.set(spaceId, spaceDb);

  // synchronous=NORMAL is connection-local; must be applied on every new connection.
  await applySpaceDbPragmas(spaceDb);

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
