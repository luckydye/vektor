import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { config } from "#config";
import { isInMemoryDb } from "#inMemoryDb";

const DEFAULT_AUTH_DATABASE_PATH = path.resolve("data", "auth.db");
const LOCAL_SPACES_DIRECTORY = path.resolve("data", "spaces");

export type Database = ReturnType<typeof drizzle>;

declare global {
  // biome-ignore lint: globalThis augmentation requires var
  var __vektor_auth_db: Database | undefined;
}

function filePathFromDatabaseUrl(databaseUrl: string): string | null {
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
  const databasePath = filePathFromDatabaseUrl(databaseUrl);
  if (!databasePath) return;
  const directory = path.dirname(databasePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
}

function authTokenFromUrl(databaseUrl: string): string | undefined {
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
    config().DATABASE_URL?.trim() || pathToFileURL(DEFAULT_AUTH_DATABASE_PATH).href
  );
}

export function isLocalDatabaseMode(): boolean {
  return getAuthDatabaseUrl().startsWith("file:");
}

export function getLocalSpacesDirectory(): string {
  return LOCAL_SPACES_DIRECTORY;
}

export function getLocalSpaceDatabaseUrl(spaceId: string): string {
  return `file:./data/spaces/${spaceId}.db`;
}

export function getDatabaseFilePath(databaseUrl: string): string | null {
  return filePathFromDatabaseUrl(databaseUrl);
}

export function withoutDatabaseCredentials(databaseUrl: string): string {
  if (databaseUrl.startsWith("file:")) return databaseUrl;
  const parsed = new URL(databaseUrl);
  parsed.username = "";
  parsed.password = "";
  parsed.searchParams.delete("authToken");
  return parsed.toString();
}

export function createDatabase(databaseUrl: string): Database {
  ensureLocalDatabaseDirectory(databaseUrl);
  const client = createClient({
    url: databaseUrl,
    // Space URLs in the auth index intentionally contain no credentials. A
    // shared credential embedded in VEKTOR_DATABASE_URL is inherited here.
    authToken: authTokenFromUrl(getAuthDatabaseUrl()),
  });
  return drizzle(client);
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
