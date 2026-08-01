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

  /** Everything the view needs, recomputed together so none of it can go stale. */
  const target = createMemo(() => {
    const found = match();
    const space = currentSpace();
    if (!found || !space) return null;
    return {
      extensionId: found.extension.id,
      routePath: routePath(),
      spaceId: space.id,
    };
  });

  return (
    <div class="relative flex h-dvh flex-col overflow-x-hidden">
      <inset-view class="relative my-1.5 block h-full flex-1 overflow-hidden md:mr-(--inset-right) md:ml-(--inset-left)">
        {/* `target()`, not a value captured from the callback. `Show` runs its
            body once, when `when` first becomes truthy — and navigating from
            one extension route to another leaves it truthy, so a captured
            extension id would stay pointed at whichever route was opened
            first while `routePath` kept updating. */}
        <Show when={target()}>
          {(resolved) => (
            <ExtensionView
              extensionId={resolved().extensionId}
              routePath={resolved().routePath}
              spaceId={resolved().spaceId}
              fill
            />
          )}
        </Show>
      </inset-view>
    </div>
  );
}
