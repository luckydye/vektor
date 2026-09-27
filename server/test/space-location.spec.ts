/**
 * `space_index.location` and the migration that produced it.
 *
 * The column was `database_url` and held a file URL. It is a locator now, read
 * per dialect by `resolveSpaceLocation` — so the rename has to carry existing
 * rows across, and the reading has to keep matching what `openSpaceDb` did when
 * it interpreted the URL inline.
 */

import { createClient } from "@libsql/client";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { resolveSpaceLocation } from "#db/client/connection.ts";
import { prepareAuthDb } from "#db/client/init.ts";
import { many, one } from "#db/client/query.ts";
import { spaceIndex } from "#db/schema/auth.ts";

/** The `space_index` shape shipped when the column was still `database_url`. */
const LEGACY_SPACE_INDEX = `CREATE TABLE space_index (
  "id" TEXT PRIMARY KEY NOT NULL,
  "database_url" TEXT NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'available',
  "space_id" TEXT UNIQUE,
  "name" TEXT,
  "slug" TEXT,
  "created_by" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
)`;

function memoryDb() {
  return drizzle(createClient({ url: "file::memory:" }));
}

async function columnNames(
  db: ReturnType<typeof memoryDb>,
  table: string,
): Promise<string[]> {
  const rows = await many<{ name: string }>(db, sql.raw(`PRAGMA table_info(${table})`));
  return rows.map((row) => String(row.name));
}

describe("space_index.location migration", () => {
  it("creates the column under its current name", async () => {
    const db = memoryDb();
    await prepareAuthDb(db);

    const columns = await columnNames(db, "space_index");
    expect(columns).toContain("location");
    expect(columns).not.toContain("database_url");
  });

  it("renames database_url and keeps the rows", async () => {
    const db = memoryDb();
    await db.run(sql.raw(LEGACY_SPACE_INDEX));
    await db.run(
      sql`INSERT INTO space_index (id, database_url, status, space_id, created_at, updated_at)
          VALUES ('database_1', 'file:./data/spaces/space_1.db', 'active', 'space_1', 1700000000, 1700000000)`,
    );

    await prepareAuthDb(db);

    expect(await columnNames(db, "space_index")).toContain("location");
    const record = await one(db.select().from(spaceIndex));
    expect(record?.location).toBe("file:./data/spaces/space_1.db");
    expect(record?.spaceId).toBe("space_1");
  });

  it("is idempotent across repeated opens", async () => {
    const db = memoryDb();
    await db.run(sql.raw(LEGACY_SPACE_INDEX));
    await prepareAuthDb(db);
    await prepareAuthDb(db);

    const columns = await columnNames(db, "space_index");
    expect(columns.filter((name) => name === "location")).toHaveLength(1);
  });

  it("keeps the unique constraint through the rename", async () => {
    const db = memoryDb();
    await db.run(sql.raw(LEGACY_SPACE_INDEX));
    await prepareAuthDb(db);

    const insert = (id: string) =>
      db.run(
        sql`INSERT INTO space_index (id, location, status, created_at, updated_at)
            VALUES (${id}, 'file:./data/spaces/dup.db', 'available', 1700000000, 1700000000)`,
      );
    await insert("database_1");
    await expect(insert("database_2")).rejects.toThrow();
  });
});

describe("resolveSpaceLocation", () => {
  it("reads a local file location", () => {
    const resolved = resolveSpaceLocation("file:./data/spaces/space_1.db");
    expect(resolved.url).toBe("file:./data/spaces/space_1.db");
    expect(resolved.filePath?.endsWith("/data/spaces/space_1.db")).toBe(true);
    expect(resolved.localFile).toBe(true);
  });

  it("reads an in-memory location as a private database", () => {
    const resolved = resolveSpaceLocation("memory:space_1");
    expect(resolved.url).toBe("file::memory:");
    expect(resolved.filePath).toBeNull();
    // Not a durable file, so it gets none of the file pragmas.
    expect(resolved.localFile).toBe(false);
  });

  it("passes a remote location through untouched", () => {
    const resolved = resolveSpaceLocation("libsql://space-1.example.com");
    expect(resolved.url).toBe("libsql://space-1.example.com");
    expect(resolved.filePath).toBeNull();
    expect(resolved.localFile).toBe(false);
  });
});
