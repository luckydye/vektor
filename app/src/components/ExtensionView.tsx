import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { type ExtensionViewElement, extensions } from "#extensions/manager.ts";

interface Props {
  extensionId: string;
  routePath: string;
  spaceId: string;
  fill?: boolean;
}

export function ExtensionView(props: Props) {
  let containerRef: ExtensionViewElement | undefined;
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  let cleanup: (() => void) | null = null;
  // Bumped per render so a slow renderer from a previous route cannot install
  // itself after navigation.
  let renderVersion = 0;

  function cleanupView() {
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error("Error cleaning up extension view:", err);
      }
      cleanup = null;
    }
    containerRef?.root?.replaceChildren();
  }

  async function renderView() {
    if (!containerRef) return;

    const version = ++renderVersion;
    cleanupView();
    setLoading(true);
    setError(null);

    try {
      await extensions.init(props.spaceId);
      if (version !== renderVersion) return;

      const root = containerRef?.root;
      if (!root) throw new Error("Extension view element is missing root");

      // Each render gets its own mount point, so an async renderer from a
      // previous route can only mutate a detached node.
      const mount = document.createElement("div");
      mount.style.height = "100%";
      mount.style.width = "100%";
      root.replaceChildren(mount);

      const nextCleanup = await extensions.renderInlineView(
        props.extensionId,
        props.routePath,
        mount,
      );

      if (version !== renderVersion) {
        nextCleanup?.();
        mount.remove();
        return;
      }

      cleanup = nextCleanup;
      if (!nextCleanup) {
        setError(`Failed to render view for route "${props.routePath}"`);
      }
    } catch (err) {
      console.error("Error rendering extension view:", err);
      if (version === renderVersion) {
        setError(`Failed to render view for route "${props.routePath}"`);
      }
    } finally {
      if (version === renderVersion) setLoading(false);
    }
  }

  // One effect covers mount and prop changes: reading the three inputs is what
  // re-runs it, which is what onMounted + watch did separately.
  createEffect(
    on([() => props.extensionId, () => props.routePath, () => props.spaceId], () => {
      void renderView();
    }),
  );

  onCleanup(() => {
    renderVersion++;
    cleanupView();
  });

  return (
    <div class="w-full" classList={{ "relative h-full": props.fill }}>
      <Show when={loading()}>
        <div class="flex items-center justify-center py-20">
          <div class="h-8 w-8 animate-spin rounded-full border-primary-600 border-b-2" />
        </div>
      </Show>

      <Show when={!loading() && error()}>
        <div class="m-12 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          <p class="font-medium">Extension Error</p>
          <p class="mt-1 text-size-medium">{error()}</p>
        </div>
      </Show>

      <extension-view
        ref={containerRef}
        class="block w-full"
        classList={{ "absolute inset-0 h-full": props.fill, hidden: loading() }}
      />
    </div>
  );
}
