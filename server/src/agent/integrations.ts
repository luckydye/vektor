import { openSpaceStore } from "#db/client/store.ts";
import { listExtensions } from "#db/space/extensions.ts";

/** A shell command an extension contributes for one of its OAuth providers. */
export interface IntegrationAgentCommand {
  extensionId: string;
  providerId: string;
  name: string;
  jobId: string;
  entry: string;
}

export interface IntegrationAgentSurface {
  /** Manifest-supplied guidance, appended to the agent system prompt. */
  instructions: string[];
  commands: IntegrationAgentCommand[];
}

/**
 * What the connected providers add to the agent. Only connected providers
 * contribute: an installed-but-unlinked integration has no token to use, so
 * naming it would only invite calls that fail.
 */
export async function getIntegrationAgentSurface(
  spaceId: string,
  connectedProviders: string[],
): Promise<IntegrationAgentSurface> {
  if (connectedProviders.length === 0) return { instructions: [], commands: [] };

  const extensions = await listExtensions(await openSpaceStore(spaceId));
  const surface: IntegrationAgentSurface = { instructions: [], commands: [] };
  const claimed = new Set<string>();

  for (const extension of extensions) {
    for (const integration of extension.manifest.integrations ?? []) {
      if (!connectedProviders.includes(integration.id) || claimed.has(integration.id)) {
        continue;
      }
      claimed.add(integration.id);

      const agent = integration.agent;
      if (agent?.instructions) surface.instructions.push(agent.instructions);

      const entry = extension.manifest.jobs?.find(
        (job) => job.id === agent?.command?.jobId,
      )?.entry;
      if (agent?.command && entry) {
        surface.commands.push({
          extensionId: extension.id,
          providerId: integration.id,
          name: agent.command.name,
          jobId: agent.command.jobId,
          entry,
        });
      }
    }
  }

  return surface;
}
