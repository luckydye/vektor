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
      {/* Sticky, and below the document header rather than under it: a column
          beside the document is a companion to whatever part of it is on
          screen, so it stays put while the document scrolls past. It is a grid
          item, so its grid area — the full height of the document row — is what
          it travels within. */}
      <aside class="hidden min-w-0 space-y-4 lg:sticky lg:top-20 lg:block">
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
