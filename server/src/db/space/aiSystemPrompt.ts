import { and, eq, isNull } from "drizzle-orm";
import { one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { preference } from "#db/schema/space.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";

/** The instructions a space adds to every agent session's system prompt. */
export async function getSpaceSystemPrompt(
  store: SpaceStore,
): Promise<string | undefined> {
  const row = await one(
    store.db
      .select({ value: preference.value })
      .from(preference)
      .where(
        and(
          eq(preference.key, spacePreferenceKeys.aiSystemPrompt),
          isNull(preference.userId),
        ),
      ),
  );
  const value = row?.value.trim();
  return value || undefined;
}
