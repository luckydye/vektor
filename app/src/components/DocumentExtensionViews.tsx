import { For, Show } from "solid-js";
import type { ExtensionRoute } from "#api/client.ts";
import { ExtensionView } from "#components/ExtensionView.tsx";
import { TableOfContents } from "#components/TableOfContents.tsx";

interface Props {
  documentId: string | null;
  fullWidth?: boolean;
  onHideTableOfContents?: () => void;
  spaceId: string;
  tableOfContents?: boolean;
  views: Array<{ extensionId: string; route: ExtensionRoute }>;
}

export function DocumentExtensionViews(props: Props) {
  return (
    <Show when={props.tableOfContents || props.views.length > 0}>
      <aside
        class={`hidden min-w-0 space-y-4 ${
          props.fullWidth
            ? "xl:sticky xl:top-20 xl:block xl:pr-m"
            : "min-[1850px]:sticky min-[1850px]:top-20 min-[1850px]:block min-[1850px]:pr-m"
        }`}
      >
        <Show when={props.tableOfContents}>
          <TableOfContents onHide={() => props.onHideTableOfContents?.()} />
        </Show>
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
