import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { type ExtensionViewElement, extensions } from "#extensions/manager.ts";

interface Props {
  extensionId: string;
  routePath: string;
  spaceId: string;
  documentId: string | null;
  fill?: boolean;
}

interface RenderTarget {
  extensionId: string;
  routePath: string;
  spaceId: string;
  documentId: string | null;
}

export function ExtensionView(props: Props) {
  let containerRef: ExtensionViewElement | undefined;
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  let cleanup: (() => void) | null = null;
  let renderVersion = 0;

  const renderTarget = createMemo<RenderTarget, undefined>(
    () => ({
      extensionId: props.extensionId,
      routePath: props.routePath,
      spaceId: props.spaceId,
      documentId: props.documentId,
    }),
    undefined,
    {
      equals: (previous, next) =>
        previous.extensionId === next.extensionId &&
        previous.routePath === next.routePath &&
        previous.spaceId === next.spaceId &&
        previous.documentId === next.documentId,
    },
  );

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

  async function renderView(target: RenderTarget) {
    if (!containerRef) return;

    const version = ++renderVersion;
    cleanupView();
    setLoading(true);
    setError(null);

    try {
      await extensions.init(target.spaceId);
      if (version !== renderVersion) return;

      extensions.setActiveDocumentId(target.documentId);

      const root = containerRef?.root;
      if (!root) throw new Error("Extension view element is missing root");

      const mount = document.createElement("div");
      mount.style.height = "100%";
      mount.style.width = "100%";
      root.replaceChildren(mount);

      const nextCleanup = await extensions.renderInlineView(
        target.extensionId,
        target.routePath,
        mount,
      );

      if (version !== renderVersion) {
        nextCleanup?.();
        mount.remove();
        return;
      }

      cleanup = nextCleanup;
      if (!nextCleanup) {
        setError(`Failed to render view for route "${target.routePath}"`);
      }
    } catch (err) {
      console.error("Error rendering extension view:", err);
      if (version === renderVersion) {
        setError(`Failed to render view for route "${target.routePath}"`);
      }
    } finally {
      if (version === renderVersion) setLoading(false);
    }
  }

  createEffect(() => {
    void renderView(renderTarget());
  });

  onCleanup(() => {
    renderVersion++;
    cleanupView();
  });

  return (
    <div class="w-full" classList={{ "relative h-full min-h-0 flex-1": props.fill }}>
      <Show when={loading()}>
        <div class="flex flex-col gap-3 p-6">
          <div class="h-4 w-1/3 animate-pulse rounded bg-neutral-100" />
          <div class="h-3 w-4/5 animate-pulse rounded bg-neutral-100" />
          <div class="h-3 w-2/3 animate-pulse rounded bg-neutral-100" />
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
