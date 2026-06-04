import { and, eq } from "drizzle-orm";
import { getSpaceDb } from "./db.ts";
import { preference } from "./schema/space.ts";
import { createId } from "./ids.ts";

const PROFILE_KEY = "ai_user_profile";

export async function getUserProfile(spaceId: string, userId: string): Promise<string | null> {
  const db = await getSpaceDb(spaceId);
  const row = await db
    .select()
    .from(preference)
    .where(and(eq(preference.key, PROFILE_KEY), eq(preference.userId, userId)))
    .get();
  return row?.value ?? null;
}

export async function setUserProfile(
  spaceId: string,
  userId: string,
  profile: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();
  const existing = await db
    .select()
    .from(preference)
    .where(and(eq(preference.key, PROFILE_KEY), eq(preference.userId, userId)))
    .get();

  if (existing) {
    await db
      .update(preference)
      .set({ value: profile, updatedAt: now })
      .where(eq(preference.id, existing.id));
  } else {
    await db.insert(preference).values({
      id: createId("preference"),
      key: PROFILE_KEY,
      value: profile,
      userId,
      createdAt: now,
      updatedAt: now,
    });
  }
}
