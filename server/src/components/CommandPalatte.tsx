import { createEffect, createSignal, For, on, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import {
  focusInlineQuickSearch,
  PALETTE_ACTION_ID,
  QUICK_SEARCH_ACTION_ID,
  type QuickSearchResult,
  quickSearchResultDescription,
  quickSearchResultIcon,
  quickSearchResultLabel,
  quickSearchSectionLabel,
  useQuickSearch,
} from "#composeables/useQuickSearch.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import {
  useVisualViewport,
  viewportLayerStyle,
} from "#composeables/useVisualViewport.ts";
import { Actions } from "#utils/actions.ts";
import { formatRelativeTime } from "#utils/dateFormat.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

export function CommandPalatte() {
  const t = useTranslation();
  const lang = useLocale();
  const viewport = useVisualViewport();

  const { currentSpace } = useSpace();

  const [isOpen, setIsOpen] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let searchInput: HTMLInputElement | undefined;
  let resultsContainer: HTMLDivElement | undefined;

  const quickSearch = useQuickSearch({ query: searchQuery, active: isOpen });
  // Closed keeps the last list so it fades out with the overlay instead of emptying first.
  const filteredResults = quickSearch.results;
  const sectionStarts = quickSearch.sectionStarts;

  function closePalette() {
    setIsOpen(false);
  }

  function togglePalette() {
    setIsOpen((open) => !open);
  }

  createEffect(
    on(isOpen, (open) => {
      if (open) {
        setSearchQuery("");
        setSelectedIndex(0);
        void quickSearch.loadHistory();
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

  function searchSpace(query: string) {
    closePalette();
    quickSearch.searchSpace(query);
  }

  function runResult(result: QuickSearchResult) {
    closePalette();
    quickSearch.runResult(result);
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

  Actions.register(PALETTE_ACTION_ID, {
    title: t("Toggle Command Palatte"),
    description: t("Open or close the command menu"),
    group: "navigation",
    run: async () => togglePalette(),
  });

  Actions.register(QUICK_SEARCH_ACTION_ID, {
    title: t("Quick Search"),
    description: t("Search documents and actions"),
    group: "navigation",
    run: async () => {
      if (isOpen() || !focusInlineQuickSearch()) togglePalette();
    },
  });

  return (
    <div>
      <a-blur
        attr:hidden={isOpen() ? undefined : ""}
        attr:enabled={isOpen() ? "" : undefined}
        class="overlay-fade fixed z-50 flex items-start justify-center overflow-hidden bg-black/30"
        style={{
          ...viewportLayerStyle(viewport()),
          "padding-top": `${Math.round(viewport().height * 0.15)}px`,
        }}
        onClick={closePalette}
        on:exit={closePalette}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: stops the click reaching the dismissal layer. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling lives on the input below. */}
        <div
          class="mx-4 flex max-h-full w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-neutral-100 bg-background shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="flex flex-none items-center gap-3 border-neutral-100 border-b px-4 py-3">
            <Icon class="h-4 w-4 flex-none text-neutral" name="search" />
            <input
              ref={searchInput}
              type="text"
              placeholder={t("Search documents and actions…")}
              class="flex-1 bg-transparent text-neutral-900 text-size-medium outline-none placeholder:text-neutral"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={handleKeydown}
            />
            <button
              type="button"
              onClick={() => searchSpace(searchQuery())}
              class="flex flex-none items-center gap-1 rounded-md px-2 py-1 font-medium text-neutral text-size-small transition-colors hover:bg-neutral-100 hover:text-neutral-800"
              title={t("Open the full search page")}
            >
              {t("Full search")}
              <Icon class="h-3 w-3" name="chevron-right-small" />
            </button>

            <a-shortcut class="hidden sm:flex" attr:data-shortcut="esc" />
          </div>

          <div
            ref={resultsContainer}
            class="min-h-0 flex-1 overflow-y-auto py-1 max-h-[400px]"
          >
            <Show when={isOpen() && filteredResults().length === 0}>
              <div class="px-4 py-10 text-center">
                <p class="text-neutral text-size-medium">{t("No results found")}</p>
              </div>
            </Show>

            <For each={filteredResults()}>
              {(result, index) => (
                <>
                  <Show when={sectionStarts().get(result.type) === index()}>
                    <div class="px-3 pt-2 pb-0.5">
                      <span class="font-medium text-neutral text-size-extra-small uppercase tracking-wider">
                        {quickSearchSectionLabel(result.type, lang)}
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
                        name={quickSearchResultIcon(result)}
                      />
                      <div class="flex min-w-0 flex-1 flex-col py-1.5">
                        <span class="truncate font-normal text-size-medium">
                          {quickSearchResultLabel(result, lang)}
                        </span>
                        <Show
                          when={
                            result.type === "document" &&
                            quickSearch.lastVisited(result.data)
                          }
                        >
                          {(visited) => (
                            <span class="flex-none text-neutral text-size-small opacity-50">
                              {formatRelativeTime(visited(), lang, { style: "short" })}
                            </span>
                          )}
                        </Show>
                        <Show when={quickSearchResultDescription(result, lang)}>
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
                {t("Navigate")}
              </span>
              <span class="flex pointer-coarse:hidden items-center gap-1">
                <a-shortcut attr:data-shortcut="↵" />
                {t("Select")}
              </span>
            </div>
            <span class="flex pointer-coarse:hidden items-center gap-1">
              <a-shortcut
                attr:data-shortcut={
                  Actions.getShortcutsForAction(QUICK_SEARCH_ACTION_ID)?.values().next()
                    .value
                }
              />
              {t("Toggle")}
            </span>
          </div>
        </div>
      </a-blur>
    </div>
  );
}
