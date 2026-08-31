import { defineCommand } from "just-bash";
import type { IntegrationAgentCommand } from "#agent/integrations.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getExtensionPackage } from "#db/space/extensions.ts";
import { runJob } from "#jobs/scheduler.ts";

/** Job outputs are `{ type, value }` pairs; anything else is treated as absent. */
function textOutput(outputs: Record<string, unknown>, key: string): string {
  const value = outputs[key];
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    return String((value as { value: unknown }).value ?? "");
  }
  return "";
}

/**
 * A shell command whose body is an extension job. The job runs in the same
 * sandbox as any other, and reaches its provider through the integration proxy,
 * so a contributed command gets no capability the extension did not already have.
 */
export function integrationCommand(
  command: IntegrationAgentCommand,
  spaceId: string,
  userId: string | null,
) {
  return defineCommand(command.name, async (args, _ctx) => {
    const zipBuffer = await getExtensionPackage(
      await openSpaceStore(spaceId),
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
        zipBuffer,
        command.entry,
        { args, provider: command.providerId },
        spaceId,
        undefined,
        { initiatedByUserId: userId, jobType: "agent_command", jobId: command.jobId },
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
  });
}
