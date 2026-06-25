import { computed, ref } from "vue";
import {
  api,
  type ExtensionInfo,
  type ExtensionManifestError,
  type ExtensionRoute,
  type ExtensionRouteMenuItem,
} from "../api/client.ts";
import { extensions } from "../utils/extensions.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";

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

  const updateMutation = useMutation({
    mutationFn: async ({
      extensionId,
      enabled,
    }: {
      extensionId: string;
      enabled: boolean;
    }) => {
      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }
      return await api.extensions.update(currentSpaceId.value, extensionId, { enabled });
    },
    onSuccess: (updatedExtension) => {
      const spaceId = currentSpaceId.value;
      queryClient.invalidateQueries({ queryKey: ["extensions", spaceId] });

      if (!spaceId) {
        return;
      }
      if (updatedExtension.enabled) {
        extensions.loadExtension(updatedExtension);
      } else {
        extensions.unloadExtension(updatedExtension.id);
      }
    },
  });

  const uploadExtension = async (file: File) => {
    return await uploadMutation.mutateAsync(file);
  };

  const deleteExtension = async (extensionId: string) => {
    return await deleteMutation.mutateAsync(extensionId);
  };

  const setExtensionEnabled = async (extensionId: string, enabled: boolean) => {
    return await updateMutation.mutateAsync({ extensionId, enabled });
  };

  const downloadPackage = async (extensionId: string) => {
    if (!currentSpaceId.value) return;
    const blob = await api.extensions.downloadPackage(currentSpaceId.value, extensionId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${extensionId}.zip`;
    a.click();
    URL.revokeObjectURL(url);
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
    isUpdating: updateMutation.isPending,
    uploadExtension,
    deleteExtension,
    setExtensionEnabled,
    downloadPackage,
    refresh,
  };
}
