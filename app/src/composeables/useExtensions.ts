import { createMemo, createSignal } from "solid-js";
import {
  api,
  type ExtensionInfo,
  type ExtensionManifestError,
  type ExtensionRoute,
  type ExtensionRouteMenuItem,
} from "#api/client.ts";
import { extensions } from "#extensions/manager.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";

export type { ExtensionInfo, ExtensionRoute, ExtensionRouteMenuItem };

/**
 * Composable for managing extensions
 *
 * Usage:
 * ```ts
 * const { extensions, isLoading, uploadExtension, deleteExtension } = useExtensions();
 * ```
 */
export function useExtensions() {
  const queryClient = useQueryClient();
  const { currentSpaceId } = useSpace();

  const [uploadError, setUploadError] = createSignal<string | null>(null);

  const {
    data: extensionList,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["extensions", currentSpaceId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) {
        return { extensions: [], errors: [] };
      }
      return await api.extensions.get(spaceId);
    },
    initialData: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) return undefined;
      return await api.extensions.getCached(spaceId);
    },
    subscribe: (callback) => {
      const spaceId = currentSpaceId();
      if (!spaceId) return () => {};
      return api.extensions.subscribeCached(spaceId, callback);
    },
    enabled: createMemo(() => !!currentSpaceId()),
  });

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const spaceId = currentSpaceId();
      if (!spaceId) {
        throw new Error("No space selected");
      }
      return await api.extensions.upload(spaceId, file);
    },
    onSuccess: (newExtension) => {
      const spaceId = currentSpaceId();
      queryClient.invalidateQueries({ queryKey: ["extensions", spaceId] });
      setUploadError(null);

      // Reload the extension in the runtime
      if (spaceId) {
        extensions.reloadExtension(newExtension.id);
      }
    },
    onError: (err) => {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (extensionId: string) => {
      const spaceId = currentSpaceId();
      if (!spaceId) {
        throw new Error("No space selected");
      }
      await api.extensions.delete(spaceId, extensionId);
      return extensionId;
    },
    onSuccess: (extensionId) => {
      const spaceId = currentSpaceId();
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
      const spaceId = currentSpaceId();
      if (!spaceId) {
        throw new Error("No space selected");
      }
      return await api.extensions.update(spaceId, extensionId, { enabled });
    },
    onSuccess: (updatedExtension) => {
      const spaceId = currentSpaceId();
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
    const spaceId = currentSpaceId();
    if (!spaceId) return;
    const blob = await api.extensions.downloadPackage(spaceId, extensionId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${extensionId}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return {
    extensions: createMemo<ExtensionInfo[]>(() => extensionList()?.extensions ?? []),
    extensionErrors: createMemo<ExtensionManifestError[]>(
      () => extensionList()?.errors ?? [],
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
