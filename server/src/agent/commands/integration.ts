import { defineCommand } from "just-bash";
import type { AgentHost } from "#agent/core.ts";
import type { IntegrationAgentCommand } from "#agent/integrations.ts";

/**
 * A shell command whose body is an extension job. The job runs on the main
 * thread's scheduler, in the same sandbox as any other, and reaches its provider
 * through the integration proxy, so a contributed command gets no capability the
 * extension did not already have.
 */
export function integrationCommand(
  command: IntegrationAgentCommand,
  options: { host: AgentHost; spaceId: string; userId: string | null },
) {
  return defineCommand(command.name, async (args) =>
    options.host.runIntegrationCommand({
      command,
      spaceId: options.spaceId,
      userId: options.userId,
      args,
    }),
  );
}
