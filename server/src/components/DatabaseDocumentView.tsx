import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { api, type ExtensionRoute } from "#api/client.ts";
import { ContextMenu } from "#components/ContextMenu.tsx";
import { ContextMenuItem } from "#components/ContextMenuItem.tsx";
import { DatabaseView } from "#components/DatabaseView.tsx";
import { Dialog } from "#components/Dialog.tsx";
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
  const [toolbarSlot, setToolbarSlot] = createSignal<HTMLElement>();
  const [viewSheetOpen, setViewSheetOpen] = createSignal(false);

  onMount(() => {
    const slot = document.querySelector<HTMLElement>("#document-toolbar-slot");
    if (!slot) throw new Error("Database views need the document toolbar slot");
    setToolbarSlot(slot);
  });
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
      <Show when={toolbarSlot()}>
        {(slot) => (
          <Portal mount={slot()}>
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border border-neutral-100 bg-background px-3 text-label @min-[60rem]:hidden"
              onClick={() => setViewSheetOpen(true)}
            >
              <Show
                when={selectedExtensionView()}
                fallback={
                  <>
                    <Icon class="h-4 w-4" name="table" />
                    Table
                  </>
                }
              >
                {(view) => (
                  <>
                    <Icon class="h-4 w-4" name="grid-grid" />
                    {extensionViewTitle(view())}
                  </>
                )}
              </Show>
              <Icon class="h-4 w-4 text-neutral-400" name="chevron-down" />
            </button>

            <div class="flex h-9 min-w-0 items-center rounded-lg bg-neutral-100/75 px-0.5 @max-[60rem]:hidden">
              <div
                role="tablist"
                class="inline-flex min-w-0 items-center gap-1 overflow-x-auto"
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
                    return (
                      <span class="inline-flex items-center">
                        <TabButton
                          selected={selectedViewId() === viewId}
                          icon="grid-grid"
                          onClick={() => selectView(viewId)}
                        >
                          {extensionViewTitle(view)}
                        </TabButton>

                        {/* Only the selected view gets one; hidden ones still took
                            their width and left uneven gaps between the tabs. */}
                        <Show when={selectedViewId() === viewId}>
                          <ContextMenu
                            ariaLabel={`Manage ${extensionViewTitle(view)} view`}
                            trigger={
                              <button
                                type="button"
                                slot="trigger"
                                aria-label={`Manage ${extensionViewTitle(view)} view`}
                                class="flex h-8 w-6 items-center justify-center text-neutral-400 transition-colors hover:text-neutral-700"
                              >
                                <Icon class="h-4 w-4" name="context-menu-more" />
                              </button>
                            }
                          >
                            <ContextMenuItem
                              onClick={(event) => void removeExtensionView(view, event)}
                            >
                              <Icon
                                class="h-4 w-4 flex-none text-red-600"
                                name="delete-entry"
                              />
                              <span class="text-red-600">Remove view</span>
                            </ContextMenuItem>
                          </ContextMenu>
                        </Show>
                      </span>
                    );
                  }}
                </For>
              </div>

              <Show when={availableExtensionViews().length > 0}>
                <ContextMenu
                  ariaLabel="Add database view"
                  placements="bottom-start"
                  trigger={
                    <button
                      type="button"
                      slot="trigger"
                      aria-label="Add view"
                      title="Add view"
                      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200/60 hover:text-neutral-700"
                    >
                      <Icon class="h-4 w-4" name="add" />
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
          </Portal>
        )}
      </Show>

      <Dialog
        show={viewSheetOpen()}
        title="Views"
        bodyClass="flex flex-col gap-1 overflow-y-auto px-3 pb-5"
        onUpdateShow={setViewSheetOpen}
      >
        <For each={[undefined, ...configuredExtensionViews()]}>
          {(view) => {
            const viewId = view ? extensionViewId(view) : TABLE_VIEW_ID;
            return (
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="flex h-11 flex-1 items-center gap-3 rounded-lg px-3 text-left text-neutral-800 text-size-medium"
                  classList={{ "bg-neutral-50 font-medium": selectedViewId() === viewId }}
                  onClick={() => {
                    selectView(viewId);
                    setViewSheetOpen(false);
                  }}
                >
                  <Icon class="h-4 w-4 flex-none" name={view ? "grid-grid" : "table"} />
                  <span class="min-w-0 flex-1 truncate">
                    {view ? extensionViewTitle(view) : "Table"}
                  </span>
                </button>
                <Show when={view}>
                  {(view) => (
                    <button
                      type="button"
                      aria-label={`Remove ${extensionViewTitle(view())} view`}
                      class="flex h-11 w-11 flex-none items-center justify-center rounded-lg text-neutral-400"
                      onClick={(event) => void removeExtensionView(view(), event)}
                    >
                      <Icon class="h-4 w-4" name="delete-entry" />
                    </button>
                  )}
                </Show>
              </div>
            );
          }}
        </For>

        <Show when={availableExtensionViews().length > 0}>
          <div class="mt-3 px-3 pb-1 text-neutral-500 text-size-extra-small">
            Add view
          </div>
          <For each={availableExtensionViews()}>
            {(view) => (
              <button
                type="button"
                class="flex h-11 items-center gap-3 rounded-lg px-3 text-left text-neutral-700 text-size-medium"
                onClick={(event) => void addExtensionView(view, event)}
              >
                <Icon class="h-4 w-4 flex-none text-neutral-400" name="add" />
                <span class="min-w-0 flex-1 truncate">{extensionViewTitle(view)}</span>
              </button>
            )}
          </For>
        </Show>
      </Dialog>

      <div
        ref={panelRef}
        role="tabpanel"
        class="flex min-h-0 flex-1 flex-col page-spacing pt-2xs"
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
