/**
 * `integer({ mode: "timestamp_ms" | "boolean" })` is the trap in generating this
 * schema from the drizzle definitions: drizzle reports those as
 * SQLiteTimestamp/SQLiteBoolean rather than SQLiteInteger, and a TEXT column
 * stores their epoch value as a string that reads back as `Invalid Date`.
 * `account.access_token_expires_at` is one, and it is what better-auth consults
 * to decide whether an OAuth access token needs refreshing.
 */

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveLocalSpaceSlugCollision } from "#db/auth/spaceIndex.ts";
import { closeDatabase, createDatabase } from "#db/client/connection.ts";
import { initSpaceDbSchema, prepareAuthDb } from "#db/client/init.ts";
import { one } from "#db/client/query.ts";
import { generateCreateTableSQL } from "#db/client/schemaUtils.ts";
import { account, spaceIndex, user } from "#db/schema/auth.ts";
import { revision, spaceMetadata, workflowSchedule } from "#db/schema/space.ts";

let authDb: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  authDb = createDatabase("file::memory:");
  await prepareAuthDb(authDb);
});

describe("auth database schema", () => {
  it("round-trips a millisecond timestamp as a usable date", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    const now = new Date();
    await authDb.insert(user).values({
      id: "user-timestamp",
      name: "Timestamp Test User",
      email: "timestamp-test@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await authDb.insert(account).values({
      id: "account-timestamp",
      accountId: "subject",
      providerId: "sso",
      userId: "user-timestamp",
      accessToken: "token",
      accessTokenExpiresAt: expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    const row = await one(
      authDb.select().from(account).where(eq(account.id, "account-timestamp")),
    );

    expect(row?.accessTokenExpiresAt).toBeInstanceOf(Date);
    // An `Invalid Date` compares unequal to everything, including itself.
    expect(row?.accessTokenExpiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  // The round trip above only catches the timestamp case: SQLite is dynamically
  // typed and drizzle coerces a boolean read back out of a TEXT column, so the
  // generated type is what has to be asserted for those.
  it("declares integer-backed columns as INTEGER", () => {
    expect(generateCreateTableSQL(account)).toContain(
      '"access_token_expires_at" INTEGER',
    );
    expect(generateCreateTableSQL(user)).toContain('"email_verified" INTEGER');
  });

  it("includes Drizzle foreign keys in generated table SQL", () => {
    expect(generateCreateTableSQL(revision)).toContain(
      'FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE',
    );
    expect(generateCreateTableSQL(workflowSchedule)).toContain(
      'FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE CASCADE',
    );
  });
});

/**
 * Two active spaces on one slug hide one of them for good, so the database is
 * what enforces uniqueness and `resolveSpaceSlug` only supplies the message.
 * The index is as old as the table, so no migration pulls colliding rows apart:
 * they were never storable.
 */
describe("active space slug uniqueness", () => {
  function activeSpaceRow(index: number, slug: string) {
    return {
      id: `database_${index}`,
      location: `memory:space_${index}`,
      status: "active" as const,
      spaceId: `space_${index}`,
      name: `Space ${index}`,
      slug,
      createdBy: "local",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it("refuses a second active space on the same slug", async () => {
    const database = createDatabase("file::memory:");
    await prepareAuthDb(database);

    await database.insert(spaceIndex).values(activeSpaceRow(1, "engineering"));
    await expect(
      database.insert(spaceIndex).values(activeSpaceRow(2, "engineering")),
    ).rejects.toThrow();
  });

  it("renames a discovered local space when its slug is already active", async () => {
    const database = createDatabase("file::memory:");
    const localSpace = createDatabase("file::memory:");
    await prepareAuthDb(database);
    await initSpaceDbSchema(localSpace, { local: false });

    const now = new Date();
    await database.insert(spaceIndex).values([
      activeSpaceRow(1, "demo"),
      activeSpaceRow(2, "demo-2"),
    ]);
    const metadata = {
      id: "space_local_copy",
      name: "Demo copy",
      slug: "demo",
      createdBy: "local",
      createdAt: now,
      updatedAt: now,
    };
    await localSpace.insert(spaceMetadata).values(metadata);

    const resolved = await resolveLocalSpaceSlugCollision(
      database,
      localSpace,
      metadata,
    );
    const stored = await one(localSpace.select().from(spaceMetadata));

    expect(resolved.slug).toBe("demo-3");
    expect(stored?.slug).toBe("demo-3");
    closeDatabase(database);
    closeDatabase(localSpace);
  });
});
