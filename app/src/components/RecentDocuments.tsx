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
      <div class="mb-4 flex items-center justify-between gap-4">
        <h2 class="text-neutral-500 text-size-large leading-large">
          {t("Recently Modified")}
        </h2>
        <a
          href={spacePath(currentSpace()?.slug, "/search")}
          class="group inline-flex shrink-0 items-center gap-1.5 text-neutral-400 text-size-medium transition-colors hover:text-neutral-700"
        >
          {t("View all")}
          <span class="transition-transform group-hover:translate-x-0.5">→</span>
        </a>
      </div>

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
            </a-track>
          </Show>
        </Show>
      </div>
    </div>
  );
}
