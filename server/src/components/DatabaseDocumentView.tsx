import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { api, type ExtensionRoute } from "#api/client.ts";
import { ContextMenu, ContextMenuSeparator } from "#components/ContextMenu.tsx";
import { ContextMenuItem } from "#components/ContextMenuItem.tsx";
import { DatabaseView } from "#components/DatabaseView.tsx";
import { ExtensionView } from "#components/ExtensionView.tsx";
import { Icon } from "#components/Icon.tsx";
import { usePersistedState } from "#composeables/usePersistedState.ts";
import { useToast } from "#composeables/useToast.ts";
import type { DocumentPropertyValue } from "#documents/properties.ts";
import { animateTabPanel } from "#utils/animate.ts";

export interface DatabaseExtensionView {
  extensionId: string;
  extensionName: string;
  route: ExtensionRoute;
}

interface Props {
  databaseDocumentId: string;
  schemaJson?: string;
  title?: string;
  spaceId: string;
  viewConfig?: DocumentPropertyValue;
  views: DatabaseExtensionView[];
  /**
   * Whether the extension list is still on its way. A configured view is
   * restored from this browser once that list names it, so the table must not
   * mount before then: it would read its first page of rows a moment before
   * the extension view replaces it.
   */
  extensionsLoading: boolean;
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
  /**
   * The persisted view is read after the first render, so until this mounts the
   * selection is only the `table` fallback. Rendering the table then would read
   * its first page of rows a moment before an extension view replaces it.
   */
  const [mounted, setMounted] = createSignal(false);

  onMount(() => {
    const slot = document.querySelector<HTMLElement>("#document-toolbar-slot");
    if (!slot) throw new Error("Database views need the document toolbar slot");
    setToolbarSlot(slot);
    setMounted(true);
  });
  const [configuredViewIds, setConfiguredViewIds] = createSignal(
    parseConfiguredViewIds(props.viewConfig),
  );
  /** A database with no configured view has no persisted view to restore. */
  const viewsPending = () =>
    props.extensionsLoading && configuredViewIds().length > 0;

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

  const viewOptions = createMemo(() => [
    { id: TABLE_VIEW_ID, title: "Table", icon: "table" as const },
    ...configuredExtensionViews().map((view) => ({
      id: extensionViewId(view),
      title: extensionViewTitle(view),
      icon: "grid-grid" as const,
    })),
  ]);

  const orderedViewIds = createMemo(() => viewOptions().map((view) => view.id));

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
  const selectedViewTitle = () => {
    const view = selectedExtensionView();
    return view ? extensionViewTitle(view) : "Table";
  };

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

  return (
    <div class="flex h-full min-h-0 flex-1 flex-col">
      <Show when={toolbarSlot()}>
        {(slot) => (
          <Portal mount={slot()}>
            <ContextMenu
              ariaLabel="Database view"
              placements="bottom-end"
              trigger={
                <button
                  type="button"
                  slot="trigger"
                  title={selectedViewTitle()}
                  class="flex h-9 items-center gap-2 rounded-lg border border-neutral-100 bg-background px-3 text-label transition-colors hover:bg-neutral-100 aria-expanded:bg-neutral-100 active:bg-neutral-200"
                >
                  <Icon
                    class="h-4 w-4"
                    name={selectedExtensionView() ? "grid-grid" : "table"}
                  />
                  {/* On phones the breadcrumb needs the room; the menu names every view. */}
                  <span class="max-w-32 truncate @max-[30rem]:sr-only">
                    {selectedViewTitle()}
                  </span>
                  <Icon class="h-4 w-4 text-neutral-400" name="chevron-down" />
                </button>
              }
            >
              <For each={viewOptions()}>
                {(view) => (
                  <ContextMenuItem
                    selected={selectedViewId() === view.id}
                    onClick={(event) => {
                      selectView(view.id);
                      (event.currentTarget as Element).dispatchEvent(
                        new CustomEvent("exit", { bubbles: true }),
                      );
                    }}
                  >
                    <Icon class="h-4 w-4 flex-none" name={view.icon} />
                    <span class="min-w-0 flex-1 truncate text-left text-neutral-900">
                      {view.title}
                    </span>
                    <Show when={selectedViewId() === view.id}>
                      <Icon class="h-4 w-4 flex-none" name="confirmation" />
                    </Show>
                  </ContextMenuItem>
                )}
              </For>
              <Show when={availableExtensionViews().length > 0}>
                <ContextMenuSeparator />
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
              </Show>
              <Show when={selectedExtensionView()}>
                {(view) => (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      class="min-w-48"
                      onClick={(event) => void removeExtensionView(view(), event)}
                    >
                      <Icon class="h-4 w-4 flex-none text-red-600" name="delete-entry" />
                      <span class="text-red-600">
                        Remove {extensionViewTitle(view())}
                      </span>
                    </ContextMenuItem>
                  </>
                )}
              </Show>
            </ContextMenu>
          </Portal>
        )}
      </Show>

      <div
        ref={panelRef}
        role="tabpanel"
        class="flex min-h-0 flex-1 flex-col page-spacing pt-2xs"
      >
        <Show
          when={selectedExtensionView()}
          fallback={
            <Show when={mounted() && !viewsPending()} fallback={null}>
              <DatabaseView
                databaseDocumentId={props.databaseDocumentId}
                schemaJson={props.schemaJson}
                title={props.title}
              />
            </Show>
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
