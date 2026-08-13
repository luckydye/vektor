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
import { createDatabase } from "#db/client/connection.ts";
import { prepareAuthDb } from "#db/client/init.ts";
import { one } from "#db/client/query.ts";
import { generateCreateTableSQL } from "#db/client/schemaUtils.ts";
import { account, spaceIndex, user } from "#db/schema/auth.ts";

let authDb: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  authDb = createDatabase("file::memory:");
  await prepareAuthDb(authDb);
});

describe("auth database schema", () => {
  it("round-trips a millisecond timestamp as a usable date", async () => {
    const expiresAt = new Date(Date.now() + 3_600_000);
    await authDb.insert(account).values({
      id: "account-timestamp",
      accountId: "subject",
      providerId: "sso",
      userId: "user-timestamp",
      accessToken: "token",
      accessTokenExpiresAt: expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
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
});
