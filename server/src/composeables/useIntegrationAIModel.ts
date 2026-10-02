import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { config } from "#config";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

export const integrationsQueryKey = (spaceId: string | null | undefined) => [
  "integrations",
  spaceId,
];

/** Whether the user runs their agent chats on a model an integration provides. */
export function useIntegrationAIModel() {
  const { currentSpaceId } = useSpace();
  const { data } = useQuery({
    queryKey: createMemo(() => integrationsQueryKey(currentSpaceId())),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) return { connections: [] };
      return await api.integrations.get(spaceId);
    },
    enabled: createMemo(() => !!currentSpaceId()),
  });

  return createMemo(
    () => data()?.connections.some((connection) => connection.aiModel) ?? false,
  );
}

/** Whether the agent chat can be used in the current space. */
export function useAgentAvailable() {
  const { currentSpace } = useSpace();
  const runsOnIntegrationModel = useIntegrationAIModel();
  return createMemo(
    () => !!currentSpace() && (config().AI_ENABLED === "1" || runsOnIntegrationModel()),
  );
}
