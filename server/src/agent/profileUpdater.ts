import { openSpaceStore } from "#db/client/store.ts";
import { reserveAITokens } from "#db/space/aiUsage.ts";
import { getUserProfile, setUserProfile } from "#db/space/userProfiles.ts";
import { resolveUserAIProvider } from "#integrations/aiProvider.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { callModel } from "./model.ts";

/** How long after the last completed turn before the profile is regenerated. */
const IDLE_DELAY_MS = 10 * 60 * 1000;

const pendingUpdates = new Map<string, ReturnType<typeof setTimeout>>();

function pendingKey(spaceId: string, userId: string): string {
  return `${spaceId}:${userId}`;
}

/**
 * Schedules a profile update for the given user.  If another turn completes
 * within IDLE_DELAY_MS the timer is reset, so the update only fires once the
 * user has been idle for a full idle window.
 *
 * @param session - The just-completed session, with its full display messages.
 */
export function scheduleProfileUpdate(
  platform: Platform,
  options: {
    spaceId: string;
    userId: string;
    session: { id: string; title: string; messages: unknown[] };
  },
): void {
  const key = pendingKey(options.spaceId, options.userId);
  const existing = pendingUpdates.get(key);
  if (existing !== undefined) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingUpdates.delete(key);
    runProfileUpdate(platform, options).catch((err) => {
      appLogger.warn("User profile update failed", {
        spaceId: options.spaceId,
        userId: options.userId,
        error: err,
      });
    });
  }, IDLE_DELAY_MS);

  pendingUpdates.set(key, timer);
}

async function runProfileUpdate(
  platform: Platform,
  options: {
    spaceId: string;
    userId: string;
    session: { id: string; title: string; messages: unknown[] };
  },
): Promise<void> {
  const store = await openSpaceStore(platform, options.spaceId);
  const provider = await resolveUserAIProvider(platform, options.spaceId, options.userId);
  const currentProfile = await getUserProfile(store, options.userId);

  type DisplayMsg = { role: string; content?: string | null };
  const transcript = (options.session.messages as DisplayMsg[])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content ?? ""}`)
    .join("\n\n")
    .slice(0, 2500);

  if (!transcript.trim()) return;

  const prompt =
    `You maintain a compact user profile used to personalize AI assistant responses.\n\n` +
    `Current profile:\n${currentProfile ?? "None"}\n\n` +
    `Recent chat session (id ${options.session.id}, title "${options.session.title}"):\n${transcript}\n\n` +
    `Update the profile. Rules:\n` +
    `- Max 250 words\n` +
    `- Capture: what they're building, stack/tools, communication style, preferred answer format/length/tone\n` +
    `- Replace stale info with newer signals; drop anything no longer relevant\n` +
    `- Be specific — only include signals that concretely help personalize future responses\n` +
    `- End with a "### Chats" section: one line per chat worth coming back to, as \`- <id>: <topic and outcome in a few words>\`. ` +
    `Update this session's line, keep at most 8 lines, drop the least relevant\n` +
    `- Return only the updated profile markdown, no commentary or wrapper text`;

  const { message } = await callModel({
    fetch: platform.fetch,
    spaceId: options.spaceId,
    provider,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    reserveAITokens: (inputTokens) => reserveAITokens(store, inputTokens),
  });

  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (!content) return;

  await setUserProfile(store, options.userId, content);
  appLogger.info("User profile updated", {
    spaceId: options.spaceId,
    userId: options.userId,
  });
}
