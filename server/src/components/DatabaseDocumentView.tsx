import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { api, type ExtensionRoute } from "#api/client.ts";
import { ContextMenu } from "#components/ContextMenu.tsx";
import { ContextMenuItem } from "#components/ContextMenuItem.tsx";
import { DatabaseView } from "#components/DatabaseView.tsx";
import { ExtensionView } from "#components/ExtensionView.tsx";
import { Icon } from "#components/Icon.tsx";
import { usePersistedState } from "#composeables/usePersistedState.ts";
import { useToast } from "#composeables/useToast.ts";
import type { DocumentPropertyValue } from "#documents/properties.ts";
import { animateTabPanel } from "#utils/animate.ts";
import { TabButton } from "./Tabs.tsx";

export interface DatabaseExtensionView {
  extensionId: string;
  extensionName: string;
  route: ExtensionRoute;
}

interface Props {
  databaseDocumentId: string;
  schemaJson?: string;
  spaceId: string;
  viewConfig?: DocumentPropertyValue;
  views: DatabaseExtensionView[];
}

const TABLE_VIEW_ID = "table";
const DATABASE_VIEWS_PROPERTY = "_databaseViews";

function parseConfiguredViewIds(value: DocumentPropertyValue | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    const ids = Array.isArray(parsed) ? parsed : parsed?.viewIds;
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

function extensionViewId(view: DatabaseExtensionView): string {
  return `${view.extensionId}:${view.route.path}`;
}

function extensionViewTitle(view: DatabaseExtensionView): string {
  return view.route.title?.trim() || view.extensionName;
}

export function DatabaseDocumentView(props: Props) {
  const { error: toastError } = useToast();
  let panelRef: HTMLDivElement | undefined;
  const [configuredViewIds, setConfiguredViewIds] = createSignal(
    parseConfiguredViewIds(props.viewConfig),
  );

  let previousDatabaseDocumentId = props.databaseDocumentId; // solid-reactivity-ok: snapshot by design
  let previousViewConfigKey = JSON.stringify(parseConfiguredViewIds(props.viewConfig));

  const configuredExtensionViews = createMemo(() => {
    const configured = new Set(configuredViewIds());
    return props.views.filter((view) => configured.has(extensionViewId(view)));
  });

  const availableExtensionViews = createMemo(() => {
    const configured = new Set(configuredViewIds());
    return props.views.filter((view) => !configured.has(extensionViewId(view)));
  });

  const orderedViewIds = createMemo(() => [
    TABLE_VIEW_ID,
    ...configuredExtensionViews().map(extensionViewId),
  ]);

  let animatedViewId = TABLE_VIEW_ID;

  const {
    value: selectedViewId,
    commit: selectView,
    set: setSelectedViewId,
  } = usePersistedState<string>({
    key: () => `database-view:${props.databaseDocumentId}`,
    fallback: TABLE_VIEW_ID,
    canApply: (viewId) => orderedViewIds().includes(viewId),
    onAdopt: (viewId) => {
      animatedViewId = viewId;
    },
  });

  const selectedExtensionView = createMemo(() =>
    configuredExtensionViews().find((view) => extensionViewId(view) === selectedViewId()),
  );

  createEffect(() => {
    const viewIds = orderedViewIds();
    const nextViewId = selectedViewId();
    if (nextViewId === animatedViewId) return;

    const from = viewIds.indexOf(animatedViewId);
    const to = viewIds.indexOf(nextViewId);
    animatedViewId = nextViewId;
    if (to === -1) return;

    const direction = from === -1 || to > from ? "next" : "previous";
    requestAnimationFrame(() => {
      const content = panelRef?.firstElementChild as HTMLElement | null;
      if (content) animateTabPanel(content, direction);
    });
  });

  createEffect(() => {
    if (
      selectedViewId() !== TABLE_VIEW_ID &&
      !configuredExtensionViews().some(
        (view) => extensionViewId(view) === selectedViewId(),
      )
    ) {
      setSelectedViewId(TABLE_VIEW_ID);
    }
  });

  createEffect(() => {
    const databaseDocumentId = props.databaseDocumentId; // solid-reactivity-ok: tracked read, inside the effect
    const nextConfiguredViewIds = parseConfiguredViewIds(props.viewConfig);
    const viewConfigKey = JSON.stringify(nextConfiguredViewIds);

    if (databaseDocumentId !== previousDatabaseDocumentId) {
      previousDatabaseDocumentId = databaseDocumentId;
      previousViewConfigKey = viewConfigKey;
      setConfiguredViewIds(nextConfiguredViewIds);
      return;
    }

    if (viewConfigKey !== previousViewConfigKey) {
      previousViewConfigKey = viewConfigKey;
      setConfiguredViewIds(nextConfiguredViewIds);
    }
  });

  async function addExtensionView(view: DatabaseExtensionView, event: Event) {
    const viewId = extensionViewId(view);
    const previous = configuredViewIds();
    const next = previous.includes(viewId) ? previous : [...previous, viewId];

    setConfiguredViewIds(next);
    selectView(viewId);
    (event.currentTarget as Element).dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );

    try {
      await api.document.patch(props.spaceId, props.databaseDocumentId, {
        properties: {
          [DATABASE_VIEWS_PROPERTY]: {
            value: JSON.stringify({ viewIds: next }),
          },
        },
      });
    } catch (error) {
      setConfiguredViewIds(previous);
      selectView(TABLE_VIEW_ID);
      toastError(error instanceof Error ? error.message : "Failed to add view");
    }
  }

  async function removeExtensionView(view: DatabaseExtensionView, event: Event) {
    const viewId = extensionViewId(view);
    const previous = configuredViewIds();
    const next = previous.filter((configuredId) => configuredId !== viewId);
    const wasSelected = selectedViewId() === viewId;

    setConfiguredViewIds(next);
    if (wasSelected) selectView(TABLE_VIEW_ID);
    (event.currentTarget as Element).dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );

    try {
      await api.document.patch(props.spaceId, props.databaseDocumentId, {
        properties: {
          [DATABASE_VIEWS_PROPERTY]: {
            value: JSON.stringify({ viewIds: next }),
          },
        },
      });
    } catch (error) {
      setConfiguredViewIds(previous);
      if (wasSelected) selectView(viewId);
      toastError(error instanceof Error ? error.message : "Failed to remove view");
    }
  }

  function onTabKeyDown(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    const tabList = event.currentTarget as HTMLElement;
    const tabs = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (currentIndex === -1) return;

    event.preventDefault();
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  }

  return (
    <div class="flex h-full min-h-0 flex-1 flex-col">
      <div class="flex shrink-0 items-center overflow-x-auto px-3xs py-2xs lg:px-s">
        <div
          role="tablist"
          class="inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-neutral-100/75 px-1 py-0.5"
          aria-label="Database views"
          onKeyDown={onTabKeyDown}
        >
          <TabButton
            selected={selectedViewId() === TABLE_VIEW_ID}
            icon="table"
            onClick={() => selectView(TABLE_VIEW_ID)}
          >
            Table
          </TabButton>
          <For each={configuredExtensionViews()}>
            {(view) => {
              const viewId = extensionViewId(view);
              // No background of its own: the tab paints the pill, and a
              // second one behind it doubles the tone and spreads it under the
              // menu button.
              return (
                <span class="group/view inline-flex h-8 items-center rounded-md">
                  <TabButton
                    selected={selectedViewId() === viewId}
                    icon="grid-grid"
                    onClick={() => selectView(viewId)}
                  >
                    {extensionViewTitle(view)}
                  </TabButton>

                  <ContextMenu
                    ariaLabel={`Manage ${extensionViewTitle(view)} view`}
                    trigger={
                      <button
                        type="button"
                        slot="trigger"
                        aria-label={`Manage ${extensionViewTitle(view)} view`}
                        // No background of its own: it used to sit flush
                        // against one the wrapper drew behind the whole tab,
                        // and alone it reads as a second, darker control.
                        class="flex h-8 w-7 items-center justify-center text-neutral-400 transition-colors hover:text-neutral-700 group-hover/view:opacity-100"
                        classList={{
                          "opacity-100": selectedViewId() === viewId,
                          "opacity-0": selectedViewId() !== viewId,
                        }}
                      >
                        <Icon class="h-4 w-4" name="context-menu-more" />
                      </button>
                    }
                  >
                    <ContextMenuItem
                      onClick={(event) => void removeExtensionView(view, event)}
                    >
                      <Icon class="h-4 w-4 flex-none text-red-600" name="delete-entry" />
                      <span class="text-red-600">Remove view</span>
                    </ContextMenuItem>
                  </ContextMenu>
                </span>
              );
            }}
          </For>
        </div>

        <Show when={availableExtensionViews().length > 0}>
          <div class="mx-3 h-6 w-px shrink-0 bg-neutral-100" />

          <ContextMenu
            ariaLabel="Add database view"
            placements="bottom-start"
            trigger={
              <button
                type="button"
                slot="trigger"
                class="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 font-medium text-neutral-500 text-size-medium transition-colors hover:bg-neutral-50 hover:text-neutral-800"
              >
                <Icon class="h-4 w-4" name="add" />
                View
              </button>
            }
          >
            <div class="px-3xs py-5xs text-neutral-500 text-size-extra-small">
              Add view
            </div>
            <For each={availableExtensionViews()}>
              {(view) => (
                <ContextMenuItem
                  class="min-w-48"
                  onClick={(event) => void addExtensionView(view, event)}
                >
                  <Icon class="h-4 w-4 flex-none" name="grid-grid" />
                  <span class="min-w-0 truncate text-left text-neutral-900">
                    {extensionViewTitle(view)}
                  </span>
                </ContextMenuItem>
              )}
            </For>
          </ContextMenu>
        </Show>
      </div>

      <div
        ref={panelRef}
        role="tabpanel"
        class="flex min-h-0 flex-1 flex-col px-3xs lg:px-s"
      >
        <Show
          when={selectedExtensionView()}
          fallback={
            <DatabaseView
              databaseDocumentId={props.databaseDocumentId}
              schemaJson={props.schemaJson}
            />
          }
        >
          {(view) => (
            <ExtensionView
              extensionId={view().extensionId}
              routePath={view().route.path}
              spaceId={props.spaceId}
              documentId={props.databaseDocumentId}
              fill
            />
          )}
        </Show>
      </div>
    </div>
  );
}
