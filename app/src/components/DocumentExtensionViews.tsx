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
        style={
          props.fullWidth
            ? undefined
            : {
                width:
                  "min(20rem, max(0px, calc((100vw - var(--inset-left) - var(--inset-right) - var(--document-width)) / 2 - 1.5rem + 80px)))",
              }
        }
        class={`hidden min-w-0 space-y-4 ${
          props.fullWidth
            ? "xl:sticky xl:top-20 xl:block xl:pr-m"
            : "min-[1920px]:absolute min-[1920px]:top-0 min-[1920px]:left-[calc(100%+1.5rem)] min-[1920px]:block min-[1920px]:h-full min-[1920px]:pr-m"
        }`}
      >
        <div class={props.fullWidth ? undefined : "sticky top-20 space-y-4"}>
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
        </div>
      </aside>
    </Show>
  );
}
