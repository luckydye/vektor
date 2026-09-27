import { eq, sql } from "drizzle-orm";
import type { ChatMessage } from "#api/provider/types.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { aiWeeklyUsage, preference } from "#db/schema/space.ts";
import { maxWeeklyAITokens } from "./aiConfig.ts";

const LIMIT_KEY = "aiWeeklyTokenLimit";

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

/** OpenAI-shaped proxy requests can carry image data URLs inside nested content. */
export function estimateProxyInput(body: unknown): number {
  let images = 0;
  const json = JSON.stringify(body ?? {});
  const withoutImageData = json.replace(
    /data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+/g,
    () => {
      images += 1;
      return "[image]";
    },
  );
  return Math.ceil(withoutImageData.length / 4) + images * 1024;
}

/** Avoid charging base64 image bytes as though they were prompt text. */
export function estimateModelInput(messages: ChatMessage[], tools: unknown[]): number {
  const withoutImages = messages.map((message) => ({ ...message, images: undefined }));
  const imageCount = messages.reduce(
    (sum, message) => sum + (message.images?.length ?? 0),
    0,
  );
  return estimateTokens({ messages: withoutImages, tools }) + imageCount * 1024;
}

export function weekStart(date = new Date()): string {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  utc.setUTCDate(utc.getUTCDate() - ((utc.getUTCDay() + 6) % 7));
  return utc.toISOString().slice(0, 10);
}

export async function getAIUsage(store: SpaceStore) {
  const maxLimit = maxWeeklyAITokens();
  const [pref] = await store.db
    .select({ value: preference.value })
    .from(preference)
    .where(eq(preference.key, LIMIT_KEY))
    .limit(1);
  const configured = Number(pref?.value);
  const limit =
    pref && Number.isSafeInteger(configured) && configured > 0
      ? Math.min(configured, maxLimit)
      : maxLimit;
  const week = weekStart();
  const [row] = await store.db
    .select({ tokens: aiWeeklyUsage.tokens })
    .from(aiWeeklyUsage)
    .where(eq(aiWeeklyUsage.weekStart, week))
    .limit(1);
  return { weekStart: week, used: row?.tokens ?? 0, limit, maxLimit };
}

export async function reserveAITokens(
  store: SpaceStore,
  inputTokens: number,
): Promise<(actualTokens?: number) => Promise<void>> {
  const input = Math.max(1, Math.ceil(inputTokens));
  let week = weekStart();
  let amount = 0;
  await store.tx(async (tx) => {
    const usage = await getAIUsage(tx);
    week = usage.weekStart;
    const remaining = usage.limit - usage.used;
    if (input >= remaining) {
      throw new AIWeeklyLimitError(usage.limit, usage.used);
    }
    amount = input + Math.min(4096, remaining - input);
    await tx.db
      .insert(aiWeeklyUsage)
      .values({ weekStart: week, tokens: amount })
      .onConflictDoUpdate({
        target: aiWeeklyUsage.weekStart,
        set: { tokens: sql`${aiWeeklyUsage.tokens} + ${amount}` },
      });
  });
  let settled = false;
  return async (actualTokens = amount) => {
    if (settled) return;
    settled = true;
    const difference = Math.max(0, Math.ceil(actualTokens)) - amount;
    if (difference !== 0) {
      await store.db
        .update(aiWeeklyUsage)
        .set({ tokens: sql`MAX(0, ${aiWeeklyUsage.tokens} + ${difference})` })
        .where(eq(aiWeeklyUsage.weekStart, week));
    }
  };
}

export class AIWeeklyLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super(
      `Weekly AI token limit reached (${used.toLocaleString()} / ${limit.toLocaleString()} estimated tokens).`,
    );
  }
}
