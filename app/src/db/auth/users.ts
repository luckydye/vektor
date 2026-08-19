import { inArray, sql } from "drizzle-orm";
import { getAuthDb } from "#db/client/db.ts";
import { many } from "#db/client/query.ts";
import { user } from "#db/schema/auth.ts";

/** Resolve account IDs from email addresses. Matching is case-insensitive. */
export async function getUserIdsByEmail(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return [];

  const normalized = emails.map((email) => email.trim().toLowerCase());
  const rows = await many(
    getAuthDb()
      .select({ id: user.id })
      .from(user)
      .where(inArray(sql<string>`lower(${user.email})`, normalized)),
  );
  return rows.map(({ id }) => id);
}
