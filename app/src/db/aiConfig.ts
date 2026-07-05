import { eq, inArray } from "drizzle-orm";
import type { AIProvider } from "../provider/types.ts";
import { getSpaceDb } from "./db.ts";
import { createId } from "./ids.ts";
import { preference, spaceSecret } from "./schema/space.ts";
import { decryptSecret, encryptSecret } from "./secretsCrypto.ts";

const AI_PROVIDER_KEY = "ai:provider";
const AI_MODEL_KEY = "ai:model";
const AI_BASE_URL_KEY = "ai:baseUrl";
const AI_API_KEY_SECRET = "__ai_api_key";

const AI_PREF_KEYS = [AI_PROVIDER_KEY, AI_MODEL_KEY, AI_BASE_URL_KEY];

export async function getAIProvider(spaceId: string): Promise<AIProvider> {
  const db = await getSpaceDb(spaceId);

  const prefs = await db
    .select()
    .from(preference)
    .where(inArray(preference.key, AI_PREF_KEYS))
    .all();

  const prefMap = Object.fromEntries(prefs.map((p) => [p.key, p.value]));
  const provider = prefMap[AI_PROVIDER_KEY];
  const model = prefMap[AI_MODEL_KEY];

  if (!provider || !model) {
    throw new Error(
      `AI provider not configured for space "${spaceId}". Configure it in space settings.`,
    );
  }

  if (provider === "ollama") {
    const baseUrl = prefMap[AI_BASE_URL_KEY];
    if (!baseUrl) throw new Error("AI config: missing baseUrl for ollama provider");
    return { provider: "ollama", baseUrl, model };
  }

  if (provider === "anthropic" || provider === "openrouter") {
    const secretRow = await db
      .select()
      .from(spaceSecret)
      .where(eq(spaceSecret.name, AI_API_KEY_SECRET))
      .limit(1)
      .get();

    if (!secretRow) {
      throw new Error(
        `AI config: missing API key for space "${spaceId}". Configure it in space settings.`,
      );
    }

    const apiKey = decryptSecret({
      ciphertext: secretRow.ciphertext,
      iv: secretRow.iv,
      authTag: secretRow.authTag,
    });

    return { provider, apiKey, model };
  }

  throw new Error(`AI config: unknown provider "${provider}"`);
}

export async function setAIConfig(
  spaceId: string,
  config: AIProvider,
  userId: string,
): Promise<void> {
  const db = await getSpaceDb(spaceId);
  const now = new Date();

  async function upsertPref(key: string, value: string) {
    const existing = await db
      .select()
      .from(preference)
      .where(eq(preference.key, key))
      .limit(1)
      .get();
    if (existing) {
      await db
        .update(preference)
        .set({ value, updatedAt: now })
        .where(eq(preference.id, existing.id));
    } else {
      await db.insert(preference).values({
        id: createId("preference"),
        key,
        value,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  await upsertPref(AI_PROVIDER_KEY, config.provider);
  await upsertPref(AI_MODEL_KEY, config.model);

  if (config.provider === "ollama") {
    await upsertPref(AI_BASE_URL_KEY, config.baseUrl);
    await db.delete(spaceSecret).where(eq(spaceSecret.name, AI_API_KEY_SECRET));
  } else {
    await db.delete(preference).where(eq(preference.key, AI_BASE_URL_KEY));

    const encrypted = encryptSecret(config.apiKey);
    const existing = await db
      .select()
      .from(spaceSecret)
      .where(eq(spaceSecret.name, AI_API_KEY_SECRET))
      .limit(1)
      .get();

    if (existing) {
      await db
        .update(spaceSecret)
        .set({
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          updatedAt: now,
        })
        .where(eq(spaceSecret.id, existing.id));
    } else {
      await db.insert(spaceSecret).values({
        id: createId("secret"),
        name: AI_API_KEY_SECRET,
        description: "AI provider API key",
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
      });
    }
  }
}

export async function deleteAIConfig(spaceId: string): Promise<void> {
  const db = await getSpaceDb(spaceId);
  await db.delete(preference).where(inArray(preference.key, AI_PREF_KEYS));
  await db.delete(spaceSecret).where(eq(spaceSecret.name, AI_API_KEY_SECRET));
}

export type AIConfigMeta =
  | {
      configured: false;
    }
  | {
      configured: true;
      provider: string;
      model: string;
      baseUrl?: string;
      hasApiKey: boolean;
    };

export async function getAIConfigMeta(spaceId: string): Promise<AIConfigMeta> {
  const db = await getSpaceDb(spaceId);

  const prefs = await db
    .select()
    .from(preference)
    .where(inArray(preference.key, AI_PREF_KEYS))
    .all();

  const prefMap = Object.fromEntries(prefs.map((p) => [p.key, p.value]));

  if (!prefMap[AI_PROVIDER_KEY] || !prefMap[AI_MODEL_KEY]) {
    return { configured: false };
  }

  const secretRow = await db
    .select({ name: spaceSecret.name })
    .from(spaceSecret)
    .where(eq(spaceSecret.name, AI_API_KEY_SECRET))
    .limit(1)
    .get();

  return {
    configured: true,
    provider: prefMap[AI_PROVIDER_KEY],
    model: prefMap[AI_MODEL_KEY],
    ...(prefMap[AI_BASE_URL_KEY] ? { baseUrl: prefMap[AI_BASE_URL_KEY] } : {}),
    hasApiKey: !!secretRow,
  };
}
