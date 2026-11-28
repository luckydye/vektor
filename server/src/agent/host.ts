import type { AgentHost } from "#agent/core.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { reserveAITokens } from "#db/space/aiUsage.ts";
import { getExtensionPackage } from "#db/space/extensions.ts";
import { runJob } from "#jobs/scheduler.ts";
import type { Platform } from "#platform/platform.ts";

/** Job outputs are `{ type, value }` pairs; anything else is treated as absent. */
function textOutput(outputs: Record<string, unknown>, key: string): string {
  const value = outputs[key];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    return String((value as { value: unknown }).value ?? "");
  }
  return "";
}

/** The agent's access to the space databases and the job scheduler, on the main thread. */
export function createAgentHost(platform: Platform): AgentHost {
  return {
    async reserveAITokens(spaceId, inputTokens) {
      return reserveAITokens(await openSpaceStore(platform, spaceId), inputTokens);
    },

    async runIntegrationCommand({ command, spaceId, userId, args }) {
      const zipBuffer = await getExtensionPackage(
        await openSpaceStore(platform, spaceId),
        command.extensionId,
      );
      if (!zipBuffer) {
        return {
          stdout: "",
          stderr: `${command.name}: extension package not found\n`,
          exitCode: 127,
        };
      }

      try {
        const outputs = await runJob(
          platform,
          zipBuffer,
          command.entry,
          { args, provider: command.providerId },
          spaceId,
          undefined,
          {
            initiatedByUserId: userId,
            // Only the agent runs these, for the user it chats with.
            attribution: { app: "agent" },
            jobId: command.jobId,
          },
        );

        const exitCodeRaw = textOutput(outputs, "exitCode");
        return {
          stdout: textOutput(outputs, "stdout"),
          stderr: textOutput(outputs, "stderr"),
          exitCode: Number(exitCodeRaw) || 0,
        };
      } catch (error) {
        return {
          stdout: "",
          stderr: `${command.name}: ${error instanceof Error ? error.message : String(error)}\n`,
          exitCode: 1,
        };
      }
    },
  };
}
