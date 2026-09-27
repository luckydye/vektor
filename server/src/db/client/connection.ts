import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { config, isInMemoryDb } from "#config";

/** Resolved per call rather than at import, so `DATA_DIR` is read after config. */
export function dataDirectory(): string {
  return path.resolve(config().DATA_DIR?.trim() || "data");
}

export type Database = ReturnType<typeof drizzle>;

declare global {
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_auth_db: Database | undefined;
}

export function getDatabaseFilePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith("file:") || databaseUrl.startsWith("file::memory:")) {
    return null;
  }

  const urlWithoutQuery = databaseUrl.split("?", 1)[0];
  if (urlWithoutQuery.startsWith("file://")) {
    return fileURLToPath(urlWithoutQuery);
  }

  return path.resolve(decodeURIComponent(urlWithoutQuery.slice("file:".length)));
}

function ensureLocalDatabaseDirectory(databaseUrl: string): void {
  const databasePath = getDatabaseFilePath(databaseUrl);
  if (!databasePath) return;
  const directory = path.dirname(databasePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
}

/** The `?authToken=` a connection string carries, if any. */
export function authTokenFromDatabaseUrl(databaseUrl: string): string | undefined {
  if (databaseUrl.startsWith("file:")) return undefined;
  try {
    return new URL(databaseUrl).searchParams.get("authToken") ?? undefined;
  } catch {
    return undefined;
  }
}

export function getAuthDatabaseUrl(): string {
  if (isInMemoryDb()) return "file::memory:";
  return (
    config().DATABASE_URL?.trim() ||
    pathToFileURL(path.join(dataDirectory(), "auth.db")).href
  );
}

export function isLocalDatabaseMode(): boolean {
  return getAuthDatabaseUrl().startsWith("file:");
}

export function getLocalSpacesDirectory(): string {
  return path.join(dataDirectory(), "spaces");
}

/**
 * Absolute, so it is the same file whatever the process's working directory is
 * — and under `DATA_DIR`, which is where {@link getLocalSpacesDirectory} looks
 * for the databases this names. Locations already stored relative keep
 * resolving as they did.
 */
export function getLocalSpaceDatabaseUrl(spaceId: string): string {
  return pathToFileURL(path.join(getLocalSpacesDirectory(), `${spaceId}.db`)).href;
}

/** A space location, read for the driver in use. */
export type ResolvedSpaceLocation = {
  /** What the driver connects to. */
  url: string;
  /** Backing file, or null when the location is not one. */
  filePath: string | null;
  /** A durable file on this host, and so wants the local pragmas. */
  localFile: boolean;
};

/**
 * Read `space_index.location` for the driver in use.
 *
 * The index stores a locator, not a connection string: under libsql that is a
 * file URL, in tests `memory:{spaceId}`, and under a server dialect it would be
 * a schema name. This is the only place that distinction is interpreted, so a
 * new dialect adds a branch here rather than at every caller.
 */
export function resolveSpaceLocation(location: string): ResolvedSpaceLocation {
  // Every `:memory:` connection gets its own private database, so the space ID
  // in the locator identifies the record rather than anything to connect to.
  const inMemory = location.startsWith("memory:");
  const url = inMemory ? "file::memory:" : location;

  return {
    url,
    filePath: getDatabaseFilePath(url),
    localFile: !inMemory && url.startsWith("file:"),
  };
}

export function withoutDatabaseCredentials(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) return databaseUrl;
  const parsed = new URL(databaseUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.searchParams.delete("authToken");
  return parsed.toString();
}

/**
 * Connections whose database lives only in RAM.
 *
 * libsql gives every `:memory:` connection its own private database and tears
 * it down when a transaction ends, so these cannot run one — the table is gone
 * on the next query. Tracked here rather than re-parsing the URL later.
 */
const memoryBacked = new WeakSet<object>();

/**
 * What a connection authenticates with. Passed explicitly at every call site so
 * that no database silently inherits another tenant's credential.
 */
export type DatabaseCredentials = {
  authToken?: string;
};

export function createDatabase(
  databaseUrl: string,
  credentials: DatabaseCredentials = {},
): Database {
  ensureLocalDatabaseDirectory(databaseUrl);
  const client = createClient({
    url: databaseUrl,
    // Locations stored in the auth index carry no credentials, so an empty
    // token here means an unauthenticated connection rather than a shared one.
    authToken: credentials.authToken ?? authTokenFromDatabaseUrl(databaseUrl),
  });
  const database = drizzle(client);
  if (databaseUrl.startsWith("file::memory:") || databaseUrl === ":memory:") {
    memoryBacked.add(database);
  }
  return database;
}

/**
 * Whether `database` can run a transaction. False only for in-memory databases,
 * which are dev- and test-only — `IN_MEMORY_DB` is refused under NODE_ENV=production.
 */
export function supportsTransactions(database: object): boolean {
  return !isMemoryBackedDatabase(database);
}

/** Whether this connection *is* the data: closing it drops the database. */
export function isMemoryBackedDatabase(database: object): boolean {
  return memoryBacked.has(database);
}

export function closeDatabase(database: Database): void {
  database.$client.close();
}

export function getAuthDb(): Database {
  if (!globalThis.__vektor_auth_db) {
    globalThis.__vektor_auth_db = createDatabase(getAuthDatabaseUrl());
  }
  return globalThis.__vektor_auth_db;
}
