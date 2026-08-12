import { eq, inArray } from "drizzle-orm";
import type { AIProvider } from "#api/provider/types.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { preference, spaceSecret } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";

/**
 * Space preference keys holding the AI provider config. The provider config is
 * editor-only, but the agent itself is usable by viewers, so the client also
 * checks `ai:provider` / `ai:model` on the space payload it already has
 * (`Space.preferences`) — see `AIChatPanel.tsx`. Keep the literals in sync;
 * they cannot be shared from here without pulling the space DB into the bundle.
 */
const AI_PROVIDER_KEY = "ai:provider";
const AI_MODEL_KEY = "ai:model";
const AI_BASE_URL_KEY = "ai:baseUrl";

const AI_PREF_KEYS = [AI_PROVIDER_KEY, AI_MODEL_KEY, AI_BASE_URL_KEY];

const AI_API_KEY_SECRET = "__ai_api_key";

export async function getAIProvider(s: SpaceStore): Promise<AIProvider> {
  const prefs = await s.db
    .select()
    .from(preference)
    .where(inArray(preference.key, AI_PREF_KEYS))
    .all();

  const prefMap = Object.fromEntries(prefs.map((p) => [p.key, p.value]));
  const provider = prefMap[AI_PROVIDER_KEY];
  const model = prefMap[AI_MODEL_KEY];

  if (!provider || !model) {
    throw new Error(
      `AI provider not configured for space "${s.spaceId}". Configure it in space settings.`,
    );
  }

  if (provider === "ollama") {
    const baseUrl = prefMap[AI_BASE_URL_KEY];
    if (!baseUrl) throw new Error("AI config: missing baseUrl for ollama provider");
    return { provider: "ollama", baseUrl, model };
  }

  if (
    provider === "anthropic" ||
    provider === "openai" ||
    provider === "openrouter" ||
    provider === "opencode-zen"
  ) {
    const secretRow = await s.db
      .select()
      .from(spaceSecret)
      .where(eq(spaceSecret.name, AI_API_KEY_SECRET))
      .limit(1)
      .get();

    if (!secretRow) {
      throw new Error(
        `AI config: missing API key for space "${s.spaceId}". Configure it in space settings.`,
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
  s: SpaceStore,
  config: AIProvider,
  userId: string,
): Promise<void> {
  const now = new Date();

  async function upsertPref(key: string, value: string) {
    const existing = await s.db
      .select()
      .from(preference)
      .where(eq(preference.key, key))
      .limit(1)
      .get();
    if (existing) {
      await s.db
        .update(preference)
        .set({ value, updatedAt: now })
        .where(eq(preference.id, existing.id));
    } else {
      await s.db.insert(preference).values({
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
    await s.db.delete(spaceSecret).where(eq(spaceSecret.name, AI_API_KEY_SECRET));
  } else {
    await s.db.delete(preference).where(eq(preference.key, AI_BASE_URL_KEY));

    const encrypted = encryptSecret(config.apiKey);
    const existing = await s.db
      .select()
      .from(spaceSecret)
      .where(eq(spaceSecret.name, AI_API_KEY_SECRET))
      .limit(1)
      .get();

    if (existing) {
      await s.db
        .update(spaceSecret)
        .set({
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          updatedAt: now,
        })
        .where(eq(spaceSecret.id, existing.id));
    } else {
      await s.db.insert(spaceSecret).values({
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

export async function deleteAIConfig(s: SpaceStore): Promise<void> {
  await s.db.delete(preference).where(inArray(preference.key, AI_PREF_KEYS));
  await s.db.delete(spaceSecret).where(eq(spaceSecret.name, AI_API_KEY_SECRET));
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

export async function getAIConfigMeta(s: SpaceStore): Promise<AIConfigMeta> {
  const prefs = await s.db
    .select()
    .from(preference)
    .where(inArray(preference.key, AI_PREF_KEYS))
    .all();

  const prefMap = Object.fromEntries(prefs.map((p) => [p.key, p.value]));

  if (!prefMap[AI_PROVIDER_KEY] || !prefMap[AI_MODEL_KEY]) {
    return { configured: false };
  }

  const secretRow = await s.db
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
