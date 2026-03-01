import { computed } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import { useSpace } from "./useSpace.ts";
import { api } from "../api/client.ts";
import { useSync } from "./useSync.ts";

export interface PropertyInfo {
  name: string;
  type: string | null;
  values: string[];
}

export function useProperties() {
  const { currentSpaceId: spaceId } = useSpace();
  const queryClient = useQueryClient();

  const {
    data: propertiesData,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: computed(() => ["wiki_properties", spaceId.value]),
    queryFn: async () => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      return await api.properties.get(spaceId.value);
    },
    enabled: computed(() => !!spaceId.value),
  });

  const properties = computed(() => propertiesData.value || []);

  const getPropertyKeys = computed(() => {
    return properties.value.map((p) => p.name);
  });

  const getProperty = (name: string): PropertyInfo | undefined => {
    return properties.value.find((p) => p.name === name);
  };

  const getValuesForProperty = (name: string): string[] => {
    const property = getProperty(name);
    return property?.values || [];
  };

  const hasProperty = (name: string): boolean => {
    return properties.value.some((p) => p.name === name);
  };

  const updatePropertyMutation = useMutation({
    mutationFn: async (params: {
      documentId: string;
      name: string;
      value: string | null | undefined;
      type?: string | null;
    }) => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      await api.document.patch(spaceId.value, params.documentId, {
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
        queryKey: ["wiki_properties", spaceId.value],
      });
    },
  });

  const deletePropertyMutation = useMutation({
    mutationFn: async (params: { documentId: string; name: string }) => {
      if (!spaceId.value) {
        throw new Error("No space ID");
      }
      await api.document.patch(spaceId.value, params.documentId, {
        properties: {
          [params.name]: null,
        },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["wiki_properties", spaceId.value],
      });
    },
  });

  async function updateProperty(
    documentId: string,
    name: string,
    value: string | null | undefined,
    type?: string | null,
  ) {
    await updatePropertyMutation.mutateAsync({ documentId, name, value, type });

    if (typeof window !== "undefined" && name.toLowerCase() === "layout") {
      window.dispatchEvent(
        new CustomEvent("document:property", {
          detail: { propertyName: name, value },
        }),
      );
    }
  }

  async function deleteProperty(documentId: string, name: string) {
    await deletePropertyMutation.mutateAsync({ documentId, name });
  }

  // TODO: syncs are not scopped to documents,
  // one prop updates will send a sync event to all users anywhere in the space
  useSync(spaceId, (keys) => {
    if (keys.includes("property")) refresh();
  });

  return {
    properties,
    isLoading,
    error,
    refresh,
    getPropertyKeys,
    getProperty,
    getValuesForProperty,
    hasProperty,
    updateProperty,
    deleteProperty,
  };
}
