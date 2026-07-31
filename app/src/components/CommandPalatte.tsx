import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import {
  boltIcon,
  chevronRightThinIcon,
  documentIcon,
  searchIcon,
} from "#assets/icons.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { Actions } from "#utils/actions.ts";
import { formatRelativeTime } from "#utils/datetime.ts";
import { history } from "#utils/history.ts";
import { spacePath } from "#utils/utils.ts";

type HistoryEntry = { url: string; lastVisited: number };
// biome-ignore lint/suspicious/noExplicitAny: documents are untyped at this layer.
type Doc = any;
type Result =
  | { type: "document"; data: Doc; id?: undefined }
  | { type: "action"; id: string; data: { title?: string; description?: string } };

function documentTitle(doc: Doc): string {
  const title = doc.properties?.title;
  return title ? propertyValueToText(title) : "Untitled Document";
}

export function CommandPalatte() {
  const navigate = useNavigate();
  const { documents } = useDocuments();
  const { currentSpace } = useSpace();

  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [historyEntries, setHistoryEntries] = createSignal<HistoryEntry[]>([]);
  let searchInput: HTMLInputElement | undefined;
  let resultsContainer: HTMLDivElement | undefined;

  const getLastVisited = (doc: Doc) =>
    historyEntries().find((h) => h.url === `/doc/${doc.slug}`)?.lastVisited ?? null;

  const filteredResults = createMemo<Result[]>(() => {
    const query = searchQuery().toLowerCase().trim();
    const results: Result[] = [];

    let docs: Doc[] = documents();
    if (query) {
      docs = docs.filter((doc: Doc) => {
        const titleValue = doc.properties?.title;
        const title = titleValue
          ? propertyValueToText(titleValue).toLowerCase()
          : "untitled";
        return title.includes(query) || (doc.slug?.toLowerCase() || "").includes(query);
      });
    }

    // Most recently visited first, then everything never visited.
    const sorted = [...docs].sort((a: Doc, b: Doc) => {
      const aHistory = historyEntries().find((e) => e.url === `/doc/${a.slug}`);
      const bHistory = historyEntries().find((e) => e.url === `/doc/${b.slug}`);
      if (aHistory && bHistory) return bHistory.lastVisited - aHistory.lastVisited;
      if (aHistory) return -1;
      if (bHistory) return 1;
      return 0;
    });

    for (const doc of sorted) results.push({ type: "document", data: doc });

    for (const [id, action] of Actions.entries()) {
      if (id === "ui:toggle:palatte") continue;
      if (!query || Actions.rank(id, query) > 0) {
        results.push({ type: "action", id, data: action });
      }
    }

    return results;
  });

  const firstActionIndex = createMemo(() =>
    filteredResults().findIndex((r) => r.type === "action"),
  );

  async function loadHistory() {
    try {
      setHistoryEntries((await history.getAll()) as HistoryEntry[]);
    } catch (error) {
      console.error("Failed to load history:", error);
      setHistoryEntries([]);
    }
  }

  function closePalette() {
    setIsOpen(false);
    setSearchQuery("");
    setSelectedIndex(0);
  }

  function togglePalette() {
    setIsOpen((open) => !open);
    if (isOpen()) {
      void loadHistory();
      // No `nextTick`: the element already exists — the palette is kept
      // mounted and toggled with `hidden`, so it can be focused directly.
      searchInput?.focus();
    }
  }

  function scrollToSelected() {
    resultsContainer
      ?.querySelector(`[data-result-index="${selectedIndex()}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  async function navigateToDocument(doc: Doc) {
    if (doc?.slug) {
      const url = `/doc/${doc.slug}`;
      try {
        await history.log(url, documentTitle(doc));
      } catch (error) {
        console.error("Failed to log history:", error);
      }
      if (url.startsWith("/") && !url.startsWith("//")) navigate(url);
      else window.location.href = url;
    }
    closePalette();
  }

  function executeAction(actionId: string) {
    closePalette();
    Actions.run(actionId);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (selectedIndex() < filteredResults().length - 1) {
        setSelectedIndex((index) => index + 1);
        scrollToSelected();
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (selectedIndex() > 0) {
        setSelectedIndex((index) => index - 1);
        scrollToSelected();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = filteredResults()[selectedIndex()];
      if (selected?.type === "document") void navigateToDocument(selected.data);
      else if (selected?.type === "action") executeAction(selected.id);
    }
  }

  createEffect(on(searchQuery, () => setSelectedIndex(0), { defer: true }));

  Actions.register("ui:toggle:palatte", {
    title: "Toggle Command Palatte",
    description: "Open or close the command menu",
    group: "navigation",
    run: async () => togglePalette(),
  });

  return (
    <div>
      <a-blur
        attr:hidden={isOpen() ? undefined : ""}
        attr:enabled={isOpen() ? "" : undefined}
        class="overlay-fade fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[15vh]"
        onClick={closePalette}
        on:exit={closePalette}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the click reaching the dismissal layer. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling lives on the input below. */}
        <div
          class="mx-4 w-full max-w-[640px] overflow-hidden rounded-xl border border-neutral-100 bg-background shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="flex items-center gap-3 border-neutral-100 border-b px-4 py-3">
            <div class="svg-icon h-4 w-4 flex-none text-neutral" innerHTML={searchIcon} />
            <input
              ref={searchInput}
              type="text"
              placeholder="Search documents and actions…"
              class="flex-1 bg-transparent text-neutral-900 text-size-medium outline-none placeholder:text-neutral"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={handleKeydown}
            />
            <kbd class="hidden rounded-sm border border-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral sm:inline-block">
              ESC
            </kbd>
          </div>

          <div ref={resultsContainer} class="max-h-[400px] overflow-y-auto py-1">
            <Show when={filteredResults().length === 0}>
              <div class="px-4 py-10 text-center">
                <p class="text-neutral text-size-medium">No results found</p>
              </div>
            </Show>

            <For each={filteredResults()}>
              {(result, index) => (
                <>
                  <Show
                    when={
                      (index() === 0 && result.type === "document") ||
                      (result.type === "action" && index() === firstActionIndex())
                    }
                  >
                    <div class="px-3 pt-2 pb-0.5">
                      <span class="font-medium text-[11px] text-neutral uppercase tracking-wider">
                        {result.type === "document" ? "Documents" : "Actions"}
                      </span>
                    </div>
                  </Show>

                  <Dynamic
                    component={result.type === "document" ? "page-target" : "div"}
                    {...(result.type === "document"
                      ? {
                          "data-document-id": result.data.id,
                          "data-document-type": result.data.type ?? undefined,
                          "data-space-id": currentSpace()?.id,
                          "data-document-url": spacePath(
                            currentSpace()?.slug,
                            `/doc/${result.data.slug}`,
                          ),
                        }
                      : {})}
                    class="block px-1 [&[data-dragging]]:opacity-50"
                    on:document-drag-start={closePalette}
                  >
                    <button
                      type="button"
                      data-result-index={index()}
                      class="flex min-h-[36px] w-full items-center gap-2.5 rounded-md px-3xs text-left text-neutral-800"
                      classList={{
                        "bg-primary-100 text-primary-700": index() === selectedIndex(),
                        "hover:bg-primary-50": index() !== selectedIndex(),
                        "cursor-grab active:cursor-grabbing": result.type === "document",
                      }}
                      onClick={() =>
                        result.type === "document"
                          ? void navigateToDocument(result.data)
                          : executeAction(result.id)
                      }
                      onMouseEnter={() => setSelectedIndex(index())}
                    >
                      <div
                        class="svg-icon icon h-4 w-4 flex-none"
                        classList={{
                          "text-primary-600": index() === selectedIndex(),
                          "text-neutral-400": index() !== selectedIndex(),
                        }}
                        innerHTML={result.type === "document" ? documentIcon : boltIcon}
                      />
                      <div class="flex min-w-0 flex-1 flex-col py-1.5">
                        <span class="truncate font-normal text-size-medium">
                          {result.type === "document"
                            ? documentTitle(result.data)
                            : result.data.title || result.id}
                        </span>
                        <Show
                          when={result.type === "document" && getLastVisited(result.data)}
                        >
                          {(visited) => (
                            <span class="flex-none text-neutral text-size-small opacity-50">
                              {formatRelativeTime(visited(), { style: "short" })}
                            </span>
                          )}
                        </Show>
                        <Show when={result.type === "action" && result.data.description}>
                          <span class="truncate text-neutral text-size-small opacity-50">
                            {result.data.description}
                          </span>
                        </Show>
                      </div>
                      <div class="flex flex-none items-center gap-1">
                        <Show when={result.type === "action"}>
                          <a-shortcut
                            attr:data-shortcut={
                              result.id
                                ? Actions.getShortcutsForAction(result.id)
                                    ?.values()
                                    .next().value
                                : undefined
                            }
                          />
                        </Show>
                      </div>
                      <div
                        class="svg-icon h-3.5 w-3.5 flex-none text-neutral transition-opacity"
                        classList={{
                          "opacity-100": index() === selectedIndex(),
                          "opacity-0": index() !== selectedIndex(),
                        }}
                        innerHTML={chevronRightThinIcon}
                      />
                    </button>
                  </Dynamic>
                </>
              )}
            </For>
          </div>

          <div class="flex items-center justify-between rounded-b-xl border-neutral-100 border-t bg-neutral-50 px-4 py-2 text-[11px] text-neutral">
            <div class="flex items-center gap-3">
              <span class="flex items-center gap-1">
                <kbd class="rounded-sm border border-neutral-100 bg-background px-1.5 py-0.5 font-mono">
                  ↑↓
                </kbd>
                Navigate
              </span>
              <span class="flex items-center gap-1">
                <kbd class="rounded-sm border border-neutral-100 bg-background px-1.5 py-0.5 font-mono">
                  ↵
                </kbd>
                Select
              </span>
            </div>
            <span class="flex items-center gap-1">
              <kbd class="rounded-sm border border-neutral-100 bg-background px-1.5 py-0.5 font-mono">
                ⌘K
              </kbd>
              Toggle
            </span>
          </div>
        </div>
      </a-blur>
    </div>
  );
}
