import { For, Show } from "solid-js";
import type { ExtensionRoute } from "#api/client.ts";
import { ExtensionView } from "#components/ExtensionView.tsx";

interface Props {
  documentId: string;
  spaceId: string;
  views: Array<{ extensionId: string; route: ExtensionRoute }>;
}

export function DocumentExtensionViews(props: Props) {
  return (
    <Show when={props.views.length > 0}>
      <aside class="hidden min-w-0 space-y-4 lg:block">
        <For each={props.views}>
          {({ extensionId, route }) => (
            <ExtensionView
              extensionId={extensionId}
              routePath={route.path}
              spaceId={props.spaceId}
              documentId={props.documentId}
            />
          )}
        </For>
      </aside>
    </Show>
  );
}
