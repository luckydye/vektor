import { For, Show } from "solid-js";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useExtensionPanels } from "#composeables/useExtensions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { DockedPanel } from "./DockedPanel.tsx";
import { ExtensionView } from "./ExtensionView.tsx";

interface Props {
  documentId: string | null;
}

export function ExtensionPanels(props: Props) {
  const { toggle } = useDockedWindows();
  const { currentSpaceId } = useSpace();
  const panels = useExtensionPanels();

  return (
    <Show when={currentSpaceId()}>
      {(spaceId) => (
        <For each={panels()}>
          {(panel) => {
            const title = panel.route.title ?? panel.route.path;
            registerScopedAction(panel.id, {
              title,
              description: panel.route.description,
              group: "document:view",
              run: async () => toggle(panel.id),
            });
            return (
              <DockedPanel id={panel.id} title={title}>
                <ExtensionView
                  extensionId={panel.extensionId}
                  routePath={panel.route.path}
                  spaceId={spaceId()}
                  documentId={props.documentId}
                  fill
                />
              </DockedPanel>
            );
          }}
        </For>
      )}
    </Show>
  );
}
