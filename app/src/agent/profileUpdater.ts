import { getAIProvider } from "#db/aiConfig.ts";
import { getUserProfile, setUserProfile } from "#db/userProfiles.ts";
import { appLogger } from "#observability/logger.ts";
import { callModel } from "./core.ts";

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
 * @param sessionMessages - The full display messages array from the just-completed session.
 */
export function scheduleProfileUpdate(options: {
  spaceId: string;
  userId: string;
  sessionMessages: unknown[];
}): void {
  const key = pendingKey(options.spaceId, options.userId);
  const existing = pendingUpdates.get(key);
  if (existing !== undefined) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingUpdates.delete(key);
    runProfileUpdate(options).catch((err) => {
      appLogger.warn("User profile update failed", {
        spaceId: options.spaceId,
        userId: options.userId,
        error: err,
      });
    });
  }, IDLE_DELAY_MS);

  pendingUpdates.set(key, timer);
}

async function runProfileUpdate(options: {
  spaceId: string;
  userId: string;
  sessionMessages: unknown[];
}): Promise<void> {
  const provider = await getAIProvider(options.spaceId);
  const currentProfile = await getUserProfile(options.spaceId, options.userId);

  type DisplayMsg = { role: string; content?: string | null };
  const transcript = (options.sessionMessages as DisplayMsg[])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content ?? ""}`)
    .join("\n\n")
    .slice(0, 2500);

  if (!transcript.trim()) return;

  const prompt =
    `You maintain a compact user profile used to personalize AI assistant responses.\n\n` +
    `Current profile:\n${currentProfile ?? "None"}\n\n` +
    `Recent chat session:\n${transcript}\n\n` +
    `Update the profile. Rules:\n` +
    `- Max 150 words\n` +
    `- Capture: what they're building, stack/tools, communication style, preferred answer format/length/tone\n` +
    `- Replace stale info with newer signals; drop anything no longer relevant\n` +
    `- Be specific — only include signals that concretely help personalize future responses\n` +
    `- Return only the updated profile markdown, no commentary or wrapper text`;

  const { message } = await callModel({
    provider,
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (!content) return;

  await setUserProfile(options.spaceId, options.userId, content);
  appLogger.info("User profile updated", {
    spaceId: options.spaceId,
    userId: options.userId,
  });
}
