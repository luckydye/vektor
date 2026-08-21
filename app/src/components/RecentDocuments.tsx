import "@atrium-ui/elements/track";
import { createMemo, For, Index, Show } from "solid-js";
import { useDocuments } from "#composeables/useDocuments.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { spacePath } from "#utils/utils.ts";
import { DocumentTeaser } from "./DocumentTeaser.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  limit?: number;
}

const TEASER_TYPES = new Set(["document", "canvas", "database"]);

export function RecentDocuments(props: Props) {
  const t = useTranslation();

  const { currentSpace } = useSpace();
  const count = props.limit ?? 5;

  const { documents, isLoading: loading } = useDocuments();

  const docs = createMemo(() =>
    documents()
      .filter((doc) => TEASER_TYPES.has(doc.type ?? "document"))
      .slice(0, count),
  );

  return (
    <div>
      <h2 class="mb-4 text-size-label">{t("Recently Modified")}</h2>

      <div class="h-60">
        <Show
          when={!loading()}
          fallback={
            <div class="flex h-full overflow-hidden">
              <Index each={Array.from({ length: count })}>
                {() => (
                  <div class="w-60 flex-none pr-4">
                    <div class="aspect-video animate-pulse rounded-xl bg-neutral-100" />
                    <div class="mt-3 space-y-2">
                      <div class="h-3 w-20 animate-pulse rounded bg-neutral-100" />
                      <div class="h-5 w-full animate-pulse rounded bg-neutral-100" />
                      <div class="h-3 w-3/4 animate-pulse rounded bg-neutral-100" />
                    </div>
                  </div>
                )}
              </Index>
            </div>
          }
        >
          <Show
            when={docs().length > 0}
            fallback={
              <div class="h-full text-neutral-400 text-size-small">
                {t("No documents yet.")}
              </div>
            }
          >
            <a-track snap class="flex h-full w-full overflow-visible">
              <For each={docs()}>{(doc) => <DocumentTeaser doc={doc} />}</For>

              <a
                href={spacePath(currentSpace()?.slug, "/search")}
                class="group block w-60 flex-none pr-4"
              >
                <div class="flex aspect-video items-center justify-center rounded-xl border-2 border-neutral-200 border-dashed transition-colors group-hover:border-neutral-300">
                  <span class="font-medium text-neutral-400 text-sm transition-colors group-hover:text-neutral-500">
                    {t("View all")} →
                  </span>
                </div>
                <div class="mt-3">
                  <h4
                    class="font-bold text-size-medium italic leading-snug"
                    style={{ color: "var(--color-primary-700)" }}
                  >
                    {t("Browse all documents")}
                  </h4>
                </div>
              </a>
            </a-track>
          </Show>
        </Show>
      </div>
    </div>
  );
}
