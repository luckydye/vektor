import { createMemo, createSignal } from "solid-js";
import {
  api,
  type ExtensionInfo,
  type StoreCatalogue,
  type StoreExtension,
} from "#api/client.ts";
import { config } from "#config";
import { extensions as extensionRuntime } from "#extensions/manager.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/** A listing paired with what the space already has installed of it. */
export interface StoreListing {
  extension: StoreExtension;
  installed: ExtensionInfo | null;
  /** Installed, but at a version the store no longer calls latest. */
  updateAvailable: boolean;
}

/**
 * Browse the extension store and install from it.
 *
 * Everything goes through this server: it fronts the registry, so the browser
 * never needs cross-origin access, and the install itself is a single call that
 * names an extension rather than a URL.
 */
export function useExtensionStore(installed: () => ExtensionInfo[]) {
  const queryClient = useQueryClient();
  const { currentSpaceId } = useSpace();

  const [installError, setInstallError] = createSignal<string | null>(null);
  const [installingId, setInstallingId] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  const [category, setCategory] = createSignal<string | null>(null);

  // The server reports whether a store exists at all, but the flag is in the
  // public env too so the tab can be hidden without a round trip first.
  const storeEnabled = createMemo(() => config().MARKETPLACE_ENABLED === "1");

  const {
    data: catalogue,
    isPending: isLoading,
    error,
    refetch: refresh,
  } = useQuery({
    queryKey: createMemo(() => ["extension-store"]),
    queryFn: async (): Promise<StoreCatalogue> => await api.store.list(),
    enabled: storeEnabled,
  });

  const installedById = createMemo(() => {
    const map = new Map<string, ExtensionInfo>();
    for (const ext of installed()) map.set(ext.id, ext);
    return map;
  });

  /** Catalogue entries with install state folded in, filtered by the UI state. */
  const listings = createMemo<StoreListing[]>(() => {
    const query = search().trim().toLowerCase();
    const activeCategory = category();
    const byId = installedById();

    return (catalogue()?.extensions ?? [])
      .map((extension) => {
        const match = byId.get(extension.id) ?? null;
        return {
          extension,
          installed: match,
          updateAvailable: Boolean(match) && match?.version !== extension.version,
        };
      })
      .filter(({ extension }) => {
        if (activeCategory && !extension.categories.includes(activeCategory))
          return false;
        if (!query) return true;
        return [
          extension.name,
          extension.id,
          extension.description ?? "",
          extension.publisher,
          ...extension.keywords,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      });
  });

  const categories = createMemo(() => {
    const seen = new Set<string>();
    for (const extension of catalogue()?.extensions ?? []) {
      for (const item of extension.categories) seen.add(item);
    }
    return [...seen].sort();
  });

  const installMutation = useMutation({
    mutationFn: async ({
      extensionId,
      version,
    }: {
      extensionId: string;
      version?: string;
    }) => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No space selected");
      setInstallingId(extensionId);
      return await api.extensions.install(spaceId, extensionId, { version });
    },
    onSuccess: (extension) => {
      queryClient.invalidateQueries({ queryKey: ["extensions", currentSpaceId()] });
      setInstallError(null);
      setInstallingId(null);
      // Reload rather than load: installing over an existing version has to
      // replace the running copy, not add a second one.
      extensionRuntime.reloadExtension(extension.id);
    },
    onError: (err) => {
      setInstallError(err instanceof Error ? err.message : "Install failed");
      setInstallingId(null);
    },
  });

  const install = async (extensionId: string, version?: string) => {
    return await installMutation.mutateAsync({ extensionId, version });
  };

  return {
    storeEnabled,
    registry: createMemo(() => catalogue()?.registry ?? null),
    listings,
    categories,
    total: createMemo(() => catalogue()?.extensions.length ?? 0),
    isLoading,
    error,
    search,
    setSearch,
    category,
    setCategory,
    install,
    installError,
    installingId,
    isInstalling: installMutation.isPending,
    refresh,
  };
}
