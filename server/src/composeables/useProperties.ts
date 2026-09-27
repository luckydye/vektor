import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export function useProperties() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data: propertiesData,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_properties", spaceId()]),
    queryFn: async () => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      return await api.properties.get(spaceIdValue);
    },
    enabled: createMemo(() => !!spaceId()),
  });

  const properties = createMemo(() => propertiesData() || []);

  // TODO: syncs are not scopped to documents,
  // one prop updates will send a sync event to all users anywhere in the space
  useSync(spaceId, [realtimeTopics.properties], (keys) => {
    if (keys.includes(realtimeTopics.properties)) refresh();
  });

  // The chip filters these in place, so it takes as many as one request allows.
  const listValues = async (name: string): Promise<string[]> => {
    const spaceIdValue = spaceId();
    if (!spaceIdValue) {
      throw new Error("No space ID");
    }
    return (await api.properties.values(spaceIdValue, name, { limit: 500 })).values;
  };

  return { properties, isLoading, error, refresh, listValues };
}

/** Property writes, without subscribing to the space-wide key listing. */
export function usePropertyMutations() {
  const { currentSpaceId: spaceId } = useSpace();
  const queryClient = useQueryClient();

  const updatePropertyMutation = useMutation({
    mutationFn: async (params: {
      documentId: string;
      name: string;
      value: string | string[] | null | undefined;
      type?: string | null;
    }) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      await api.document.patch(spaceIdValue, params.documentId, {
        properties: {
          [params.name]: {
            value: params.value || "",
            type: params.type,
          },
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["wiki_properties", spaceId()],
      });
    },
  });

  const deletePropertyMutation = useMutation({
    mutationFn: async (params: { documentId: string; name: string }) => {
      const spaceIdValue = spaceId();
      if (!spaceIdValue) {
        throw new Error("No space ID");
      }
      await api.document.patch(spaceIdValue, params.documentId, {
        properties: {
          [params.name]: null,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["wiki_properties", spaceId()],
      });
    },
  });

  async function updateProperty(
    documentId: string,
    name: string,
    value: string | string[] | null | undefined,
    type?: string | null,
  ) {
    await updatePropertyMutation.mutateAsync({ documentId, name, value, type });
  }

  async function deleteProperty(documentId: string, name: string) {
    await deletePropertyMutation.mutateAsync({ documentId, name });
  }

  return { updateProperty, deleteProperty };
}
