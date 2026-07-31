import { useParams } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { ExtensionView } from "#components/ExtensionView.tsx";
import { useExtensions } from "#composeables/useExtensions.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { useSpace } from "#composeables/useSpace.ts";

export function ExtensionRouteView() {
  const { currentSpace } = useSpace();
  const { extensions } = useExtensions();
  const params = useParams();

  // The splat is named in the route (`/x/*extensionPath`) because an unnamed
  // `*` matches the path without capturing it, leaving this empty.
  const routePath = createMemo(() => params.extensionPath ?? "");

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
