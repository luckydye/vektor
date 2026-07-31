import { useParams } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { ExtensionView } from "#components/ExtensionView.tsx";
import { useExtensions } from "#composeables/useExtensions.solid.ts";
import { usePageTitle } from "#composeables/usePageTitle.solid.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";

export function ExtensionRouteView() {
  const { currentSpace } = useSpace();
  const { extensions } = useExtensions();
  const params = useParams();

  // vue-router's `pathMatch` array is a single wildcard string here.
  const routePath = createMemo(() => params["*"] ?? "");

  const match = createMemo(() => {
    const path = routePath();
    if (!path) return null;
    for (const ext of extensions()) {
      for (const route of ext.routes || []) {
        if (path === route.path || path.startsWith(`${route.path}/`)) {
          return { extension: ext, route };
        }
      }
    }
    return null;
  });

  usePageTitle(() => match()?.route.title ?? null);

  return (
    <div class="relative flex h-dvh flex-col overflow-x-hidden">
      <inset-view class="relative my-1.5 block h-full flex-1 overflow-hidden md:mr-(--inset-right) md:ml-(--inset-left)">
        <Show when={currentSpace() && match()}>
          {(_) => {
            const resolved = match();
            const space = currentSpace();
            if (!resolved || !space) return null;
            return (
              <ExtensionView
                extensionId={resolved.extension.id}
                routePath={routePath()}
                spaceId={space.id}
                fill
              />
            );
          }}
        </Show>
      </inset-view>
    </div>
  );
}
