import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { getDatabaseFilePath } from "#db/client/connection.ts";
import type { SpaceDatabase } from "#platform/platform.ts";

/** libSQL, either a local file or a hosted database over HTTP. */
export const libsqlSpaceDatabase: SpaceDatabase = {
  open(url, credentials) {
    const databasePath = getDatabaseFilePath(url);
    if (databasePath) mkdirSync(path.dirname(databasePath), { recursive: true });
    return drizzle(createClient({ url, authToken: credentials.authToken }));
  },

  close(database) {
    database.$client.close();
  },

  exists(filePath) {
    return existsSync(filePath);
  },

  listFiles(directory) {
    mkdirSync(directory, { recursive: true });
    return readdirSync(directory)
      .filter((name) => name.endsWith(".db"))
      .map((name) => path.join(directory, name));
  },

  archive(filePath, archivePath) {
    if (!existsSync(filePath)) return false;
    mkdirSync(path.dirname(archivePath), { recursive: true });
    renameSync(filePath, archivePath);
    // The journal files belong to the database that just moved; left behind
    // they are a stale WAL against whatever takes that name next.
    for (const suffix of ["-wal", "-shm"]) {
      rmSync(`${filePath}${suffix}`, { force: true });
    }
    return true;
  },

  remove(filePath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${filePath}${suffix}`, { force: true });
    }
  },
};
