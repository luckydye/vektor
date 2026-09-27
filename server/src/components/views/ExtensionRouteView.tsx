import { useParams } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { ExtensionView } from "#components/ExtensionView.tsx";
import { useExtensions } from "#composeables/useExtensions.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { hasExtensionRoutePlacement } from "#extensions/manager.ts";

export function ExtensionRouteView() {
  const { currentSpace } = useSpace();
  const { extensions } = useExtensions();
  const params = useParams();

  const routePath = createMemo(() => params.extensionPath ?? "");

  const match = createMemo(() => {
    const path = routePath();
    if (!path) return null;
    for (const ext of extensions()) {
      for (const route of ext.routes || []) {
        if (
          hasExtensionRoutePlacement(route, "standalone") &&
          (path === route.path || path.startsWith(`${route.path}/`))
        ) {
          return { extension: ext, route };
        }
      }
    }
    return null;
  });

  usePageTitle(() => match()?.route.title ?? null);

  const target = createMemo(
    () => {
      const found = match();
      const space = currentSpace();
      if (!found || !space) return null;
      return {
        extensionId: found.extension.id,
        routePath: routePath(),
        spaceId: space.id,
      };
    },
    undefined,
    {
      equals: (a, b) =>
        a?.extensionId === b?.extensionId &&
        a?.routePath === b?.routePath &&
        a?.spaceId === b?.spaceId,
    },
  );

  return (
    <div class="relative flex h-dvh flex-col overflow-x-hidden">
      <inset-view class="relative my-1.5 block h-full flex-1 overflow-hidden md:mr-(--inset-right) md:ml-(--inset-left)">
        <Show when={target()}>
          {(resolved) => (
            <ExtensionView
              extensionId={resolved().extensionId}
              routePath={resolved().routePath}
              spaceId={resolved().spaceId}
              documentId={null}
              fill
            />
          )}
        </Show>
      </inset-view>
    </div>
  );
}
