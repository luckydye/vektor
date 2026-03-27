import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";
import { prepateAuthDb, prepareSpaceDb } from "./init.ts";

const DATA_DIR = "./data";
const AUTH_DB_PATH = join(DATA_DIR, "auth.db");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const authDb = drizzle({
  connection: {
    source: path.resolve(AUTH_DB_PATH),
    create: true,
    readwrite: true,
  },
});

console.log("Initializing databases...");
prepateAuthDb(authDb);
console.log("Done! Auth database is ready.");
console.log("Space databases will be created automatically when spaces are created.");

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

export function clearSpaceDbCache() {
  spaceDbCache.clear();
}

export { schema };
