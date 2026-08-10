import "@atrium-ui/elements/popover";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { api, type ExtensionRoute } from "#api/client.ts";
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
  spaceId: string;
  viewConfig?: DocumentPropertyValue;
  views: DatabaseExtensionView[];
}

const TABLE_VIEW_ID = "table";
const DATABASE_VIEWS_PROPERTY = "_databaseViews";

const TAB_CLASS =
  "inline-flex h-9 items-center justify-center rounded-sm px-1 text-label opacity-60 transition-opacity [&[aria-selected=true]:hover>span]:bg-gray-100 [&[aria-selected=true]]:opacity-100 [&[aria-selected=true]>span]:bg-gray-100 hover:[&>span]:bg-gray-200";

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

  async function addExtensionView(view: DatabaseExtensionView, event: MouseEvent) {
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

  async function removeExtensionView(view: DatabaseExtensionView, event: MouseEvent) {
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
      <div class="flex shrink-0 items-center overflow-x-auto px-xs py-2xs lg:px-m">
        <div role="tablist" aria-label="Database views" onKeyDown={onTabKeyDown}>
          <button
            type="button"
            role="tab"
            aria-selected={selectedViewId() === TABLE_VIEW_ID}
            tabIndex={selectedViewId() === TABLE_VIEW_ID ? 0 : -1}
            class={TAB_CLASS}
            onClick={() => selectView(TABLE_VIEW_ID)}
          >
            <span class="inline-flex h-8 items-center gap-2 rounded-md px-3 transition-colors">
              <Icon class="h-4 w-4" name="table" />
              Table
            </span>
          </button>
          <For each={configuredExtensionViews()}>
            {(view) => {
              const viewId = extensionViewId(view);
              return (
                <span class="inline-flex items-center">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selectedViewId() === viewId}
                    tabIndex={selectedViewId() === viewId ? 0 : -1}
                    class={TAB_CLASS}
                    onClick={() => selectView(viewId)}
                  >
                    <span class="inline-flex h-8 items-center gap-2 rounded-md px-3 transition-colors">
                      <Icon class="h-4 w-4" name="grid-grid" />
                      {extensionViewTitle(view)}
                    </span>
                  </button>

                  <a-popover-trigger class="inline-flex">
                    <button
                      type="button"
                      slot="trigger"
                      aria-label={`Manage ${extensionViewTitle(view)} view`}
                      class="flex h-8 w-7 items-center justify-center rounded-md text-neutral-400 opacity-60 transition-colors hover:bg-gray-200 hover:text-neutral-700 hover:opacity-100"
                    >
                      <Icon class="h-4 w-4" name="context-menu-more" />
                    </button>
                    <a-popover class="group" placements="bottom-end">
                      <div class="w-max py-1 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                        <div class="min-w-40 rounded-lg border border-neutral-100 bg-background p-1 shadow-large">
                          <button
                            type="button"
                            class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-red-600 text-size-small transition-colors hover:bg-red-50"
                            onClick={(event) => void removeExtensionView(view, event)}
                          >
                            <Icon class="h-4 w-4" name="delete-entry" />
                            Remove view
                          </button>
                        </div>
                      </div>
                    </a-popover>
                  </a-popover-trigger>
                </span>
              );
            }}
          </For>
        </div>

        <Show when={availableExtensionViews().length > 0}>
          <div class="mx-3 h-6 w-px shrink-0 bg-neutral-100" />

          <a-popover-trigger>
            <button
              type="button"
              slot="trigger"
              class="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 font-medium text-neutral-500 text-size-medium transition-colors hover:bg-neutral-50 hover:text-neutral-800"
            >
              <Icon class="h-4 w-4" name="add" />
              View
            </button>
            <a-popover class="group" placements="bottom-start">
              <div class="w-max opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                <div class="mt-1 w-80 rounded-xl border border-neutral-100 bg-background p-2 shadow-large">
                  <div class="px-2 py-2 font-medium text-neutral-500 text-size-small">
                    Add a new view
                  </div>
                  <For each={availableExtensionViews()}>
                    {(view) => (
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-neutral-50"
                        onClick={(event) => void addExtensionView(view, event)}
                      >
                        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-neutral-100 bg-background shadow-small">
                          <Icon class="h-5 w-5 text-neutral-800" name="grid-grid" />
                        </span>
                        <span class="min-w-0">
                          <span class="block truncate font-medium text-neutral-800">
                            {extensionViewTitle(view)}
                          </span>
                          <span class="block truncate text-neutral-400 text-size-small">
                            {view.route.description?.trim() ||
                              `${extensionViewTitle(view)} view by ${view.extensionName}`}
                          </span>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </a-popover>
          </a-popover-trigger>
        </Show>
      </div>

      <div
        ref={panelRef}
        role="tabpanel"
        class="flex min-h-0 flex-1 flex-col px-xs lg:px-m"
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
