import { For, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import {
  type QuickSearchResult,
  quickSearchResultDescription,
  quickSearchResultIcon,
  quickSearchResultLabel,
  quickSearchSectionLabel,
} from "#composeables/useQuickSearch.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  results: QuickSearchResult[];
  sectionStarts: Map<QuickSearchResult["type"], number>;
  selectedIndex: number;
  /** The open document's slug, marked like the tree marks it. */
  activeDocumentSlug?: string | null;
  onRun: (result: QuickSearchResult, index: number) => void;
}

/** Quick search results laid out as sidebar rows, grouped under section headings. */
export function QuickSearchResults(props: Props) {
  const t = useTranslation();
  const lang = useLocale();

  return (
    <div class="flex flex-col gap-0.5" role="listbox" aria-label={t("Search results")}>
      <Show when={props.results.length === 0}>
        <p class="px-3xs py-6 text-center text-neutral-500 text-size-normal">
          {t("No results found")}
        </p>
      </Show>

      <For each={props.results}>
        {(result, index) => {
          const isSelected = () => index() === props.selectedIndex;
          const isActiveDocument = () =>
            result.type === "document" &&
            !!props.activeDocumentSlug &&
            result.data.slug === props.activeDocumentSlug;

          return (
            <>
              <Show when={props.sectionStarts.get(result.type) === index()}>
                <div
                  class="px-3xs pb-0.5 font-medium text-neutral-500 text-size-extra-small uppercase tracking-wider"
                  classList={{ "pt-3xs": index() > 0 }}
                >
                  {quickSearchSectionLabel(result.type, lang)}
                </div>
              </Show>

              <button
                type="button"
                role="option"
                aria-selected={isSelected()}
                data-result-index={index()}
                title={quickSearchResultDescription(result, lang)}
                // Not twMerge: it reads `text-size-normal` as a colour and drops it
                // for `text-primary-700`, which would enlarge the selected row.
                class="button-with-icon flex min-h-[32px] w-full items-center rounded-md px-3xs text-left text-size-normal"
                classList={{
                  "bg-primary-100 text-primary-700": isSelected() || isActiveDocument(),
                  "text-neutral-800 hover:bg-primary-50 active:bg-primary-100": !(
                    isSelected() || isActiveDocument()
                  ),
                }}
                onClick={() => props.onRun(result, index())}
              >
                <Icon
                  class={twMerge(
                    "flex-none",
                    isSelected() ? "text-primary-600" : "text-neutral-400",
                  )}
                  name={quickSearchResultIcon(result)}
                />
                <span class="min-w-0 flex-1 truncate">
                  {quickSearchResultLabel(result, lang)}
                </span>
              </button>
            </>
          );
        }}
      </For>
    </div>
  );
}
