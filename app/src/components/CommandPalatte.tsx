import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { useDocuments } from "#composeables/useDocuments.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { documentTitle } from "#documents/title.ts";
import { Actions } from "#utils/actions.ts";
import { formatRelativeTime } from "#utils/dateFormat.ts";
import { history } from "#utils/history.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon, type IconName } from "./Icon.tsx";

type HistoryEntry = { url: string; lastVisited: number };
// biome-ignore lint/suspicious/noExplicitAny: documents are untyped at this layer.
type Doc = any;
type Result =
  | { type: "document"; data: Doc; id?: undefined }
  | { type: "action"; id: string; data: { title?: string; description?: string } }
  | { type: "search"; title: string; space: string; id?: undefined }
  | { type: "create"; title: string; id?: undefined };

const SECTION_LABELS: Record<Result["type"], string> = {
  document: "Documents",
  action: "Actions",
  search: "Search",
  create: "Create",
};

const RESULT_ICONS: Record<Result["type"], IconName> = {
  document: "document",
  action: "bolt",
  search: "search",
  create: "new-document",
};

const MAX_DOCUMENT_RESULTS = 50;

function resultLabel(result: Result): string {
  if (result.type === "document") return documentTitle(result.data);
  if (result.type === "action") return result.data.title || result.id;
  if (result.type === "search") return `Search "${result.title}" in ${result.space}`;
  return `Create Document with title "${result.title}"`;
}

function resultDescription(result: Result): string | undefined {
  if (result.type === "action") return result.data.description;
  if (result.type === "search") return "Search the full text of every document";
  if (result.type === "create") return "Open a new document with this title";
  return undefined;
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

  const lastVisitedByUrl = createMemo(
    () => new Map(historyEntries().map((entry) => [entry.url, entry.lastVisited])),
  );

  const getLastVisited = (doc: Doc) => lastVisitedByUrl().get(`/doc/${doc.slug}`) ?? null;

  const filteredResults = createMemo<Result[]>(() => {
    if (!isOpen()) return [];

    const typed = searchQuery().trim();
    const query = typed.toLowerCase();
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

    const visited = lastVisitedByUrl();
    const sorted = [...docs].sort((a: Doc, b: Doc) => {
      const aVisited = visited.get(`/doc/${a.slug}`);
      const bVisited = visited.get(`/doc/${b.slug}`);
      if (aVisited !== undefined && bVisited !== undefined) return bVisited - aVisited;
      if (aVisited !== undefined) return -1;
      if (bVisited !== undefined) return 1;
      return 0;
    });

    for (const doc of sorted.slice(0, MAX_DOCUMENT_RESULTS))
      results.push({ type: "document", data: doc });

    for (const [id, action] of Actions.entries()) {
      if (id === "ui:toggle:palatte") continue;
      if (!query || Actions.rank(id, query) > 0) {
        results.push({ type: "action", id, data: action });
      }
    }

    const space = currentSpace();
    if (typed && space) {
      results.push({ type: "search", title: typed, space: space.name || "this space" });
    }

    if (typed && space) results.push({ type: "create", title: typed });

    return results;
  });

  const sectionStarts = createMemo(() => {
    const starts = new Map<Result["type"], number>();
    filteredResults().forEach((result, index) => {
      if (!starts.has(result.type)) starts.set(result.type, index);
    });
    return starts;
  });

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
  }

  createEffect(
    on(isOpen, (open) => {
      if (open) {
        void loadHistory();
        requestAnimationFrame(() => searchInput?.focus());
      } else if (searchInput && document.activeElement === searchInput) {
        searchInput.blur();
      }
    }),
  );

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

  function createDocumentWithTitle(title: string) {
    closePalette();
    navigate(`/new?title=${encodeURIComponent(title)}`);
  }

  function searchSpace(query: string) {
    closePalette();
    navigate(`/search?q=${encodeURIComponent(query)}`);
  }

  function runResult(result: Result) {
    if (result.type === "document") void navigateToDocument(result.data);
    else if (result.type === "action") executeAction(result.id);
    else if (result.type === "search") searchSpace(result.title);
    else createDocumentWithTitle(result.title);
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
      if (selected) runResult(selected);
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
            <Icon class="h-4 w-4 flex-none text-neutral" name="search" />
            <input
              ref={searchInput}
              type="text"
              placeholder="Search documents and actions…"
              class="flex-1 bg-transparent text-neutral-900 text-size-medium outline-none placeholder:text-neutral"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={handleKeydown}
            />
            <a-shortcut class="hidden sm:flex" attr:data-shortcut="esc" />
          </div>

          <div ref={resultsContainer} class="max-h-[400px] overflow-y-auto py-1">
            <Show when={isOpen() && filteredResults().length === 0}>
              <div class="px-4 py-10 text-center">
                <p class="text-neutral text-size-medium">No results found</p>
              </div>
            </Show>

            <For each={filteredResults()}>
              {(result, index) => (
                <>
                  <Show when={sectionStarts().get(result.type) === index()}>
                    <div class="px-3 pt-2 pb-0.5">
                      <span class="font-medium text-neutral text-size-extra-small uppercase tracking-wider">
                        {SECTION_LABELS[result.type]}
                      </span>
                    </div>
                  </Show>

                  <Dynamic
                    component={result.type === "document" ? "page-target" : "div"}
                    {...(result.type === "document"
                      ? {
                          "attr:data-document-id": result.data.id,
                          "attr:data-document-type": result.data.type ?? undefined,
                          "attr:data-space-id": currentSpace()?.id,
                          "attr:data-document-url": spacePath(
                            currentSpace()?.slug,
                            `/doc/${result.data.slug}`,
                          ),
                        }
                      : {})}
                    class="block px-1 [&[data-dragging]]:opacity-50"
                    on:drag={closePalette}
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
                      onClick={() => runResult(result)}
                      onMouseEnter={() => setSelectedIndex(index())}
                    >
                      <Icon
                        class={twMerge(
                          "h-4 w-4 flex-none",
                          index() === selectedIndex()
                            ? "text-primary-600"
                            : "text-neutral-400",
                        )}
                        name={RESULT_ICONS[result.type]}
                      />
                      <div class="flex min-w-0 flex-1 flex-col py-1.5">
                        <span class="truncate font-normal text-size-medium">
                          {resultLabel(result)}
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
                        <Show when={resultDescription(result)}>
                          {(description) => (
                            <span class="truncate text-neutral text-size-small opacity-50">
                              {description()}
                            </span>
                          )}
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
                      <Icon
                        class={twMerge(
                          "h-3.5 w-3.5 flex-none text-neutral transition-opacity",
                          index() === selectedIndex() ? "opacity-100" : "opacity-0",
                        )}
                        name="chevron-right-thin"
                      />
                    </button>
                  </Dynamic>
                </>
              )}
            </For>
          </div>

          <div class="flex items-center justify-between rounded-b-xl border-neutral-100 border-t bg-neutral-50 px-4 py-2 text-neutral text-size-extra-small">
            <div class="flex items-center gap-3">
              <span class="flex pointer-coarse:hidden items-center gap-1">
                <a-shortcut attr:data-shortcut="↑-↓" />
                Navigate
              </span>
              <span class="flex pointer-coarse:hidden items-center gap-1">
                <a-shortcut attr:data-shortcut="↵" />
                Select
              </span>
            </div>
            <span class="flex pointer-coarse:hidden items-center gap-1">
              <a-shortcut
                attr:data-shortcut={
                  Actions.getShortcutsForAction("ui:toggle:palatte")?.values().next()
                    .value
                }
              />
              Toggle
            </span>
          </div>
        </div>
      </a-blur>
    </div>
  );
}
