import { ref, computed } from "vue";
import { useQuery, useMutation, useQueryClient } from "@tanstack/vue-query";
import {
  api,
  type ExtensionInfo,
  type ExtensionRoute,
  type ExtensionRouteMenuItem,
  type ExtensionManifestError,
} from "../api/client.ts";
import { useSpace } from "./useSpace.ts";
import { extensions } from "../utils/extensions.ts";

export type { ExtensionInfo, ExtensionRoute, ExtensionRouteMenuItem };

/**
 * Vue composable for managing extensions
 *
 * Usage:
 * ```ts
 * const { extensions, isLoading, uploadExtension, deleteExtension } = useExtensions();
 * ```
 */
export function useExtensions() {
  const queryClient = useQueryClient();
  const { currentSpaceId } = useSpace();

  const uploadError = ref<string | null>(null);

  const {
    data: extensionList,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: computed(() => ["extensions", currentSpaceId.value]),
    queryFn: async () => {
      if (!currentSpaceId.value) {
        return { extensions: [], errors: [] };
      }
      return await api.extensions.get(currentSpaceId.value);
    },
    enabled: computed(() => !!currentSpaceId.value),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }
      return await api.extensions.upload(currentSpaceId.value, file);
    },
    onSuccess: (newExtension) => {
      const spaceId = currentSpaceId.value;
      queryClient.invalidateQueries({ queryKey: ["extensions", spaceId] });
      uploadError.value = null;

      // Reload the extension in the runtime
      if (spaceId) {
        extensions.reloadExtension(newExtension.id);
      }
    },
    onError: (err) => {
      uploadError.value = err instanceof Error ? err.message : "Upload failed";
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (extensionId: string) => {
      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }
      await api.extensions.delete(currentSpaceId.value, extensionId);
      return extensionId;
    },
    onSuccess: (extensionId) => {
      const spaceId = currentSpaceId.value;
      queryClient.invalidateQueries({ queryKey: ["extensions", spaceId] });

      // Unload the extension from runtime
      extensions.unloadExtension(extensionId);
    },
  });

  const uploadExtension = async (file: File) => {
    return await uploadMutation.mutateAsync(file);
  };

  const deleteExtension = async (extensionId: string) => {
    return await deleteMutation.mutateAsync(extensionId);
  };

  return {
    extensions: computed<ExtensionInfo[]>(() => extensionList.value?.extensions ?? []),
    extensionErrors: computed<ExtensionManifestError[]>(
      () => extensionList.value?.errors ?? [],
    ),
    isLoading,
    error,
    uploadError,
    isUploading: uploadMutation.isPending,
    isDeleting: deleteMutation.isPending,
    uploadExtension,
    deleteExtension,
    refresh,
  };
}
