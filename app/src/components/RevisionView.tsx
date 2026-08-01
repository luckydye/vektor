import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { BottomBanner } from "#components/BottomBanner.tsx";
import { useSpace } from "#composeables/useSpace.ts";
import { AppView } from "./AppView.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  documentId: string;
  documentType: string;
  spaceId: string;
}

type DocumentViewElement = HTMLElement & {
  renderReadHtml?: (html: string) => void;
};

export function RevisionView(props: Props) {
  const { currentSpaceId } = useSpace();
  const navigate = useNavigate();
  const location = useLocation();

  const [viewingRevision, setViewingRevision] = createSignal(false);
  const [revisionNumber, setRevisionNumber] = createSignal<number | null>(null);
  const [revisionContent, setRevisionContent] = createSignal("");
  const [viewingSuggestion, setViewingSuggestion] = createSignal(false);
  const [showingDiff, setShowingDiff] = createSignal(false);
  const [diffContent, setDiffContent] = createSignal("");

  // When viewing a diff the document element renders the inline redline instead
  // of the plain revision content; otherwise it renders the revision as-is.
  const renderedHtml = createMemo(() =>
    showingDiff() ? diffContent() : revisionContent(),
  );

  const [docViewEl, setDocViewEl] = createSignal<DocumentViewElement | null>(null);

  createEffect(() => {
    // Read both reactive deps synchronously: reads after an `await` are not
    // tracked, so the effect must depend on `renderedHtml` here to re-run when
    // the content changes (e.g. switching from a revision view to its diff)
    // and not only when the element mounts.
    const el = docViewEl();
    const html = renderedHtml();
    if (!el) return;
    void customElements.whenDefined("document-view").then(() => {
      el.renderReadHtml?.(html);
    });
  });

  function handleRevisionView(event: Event) {
    const detail = (event as CustomEvent).detail;
    setViewingRevision(true);
    document.body.dataset.revision = "true";
    setRevisionNumber(detail.revision);
    setRevisionContent(detail.content);
    setViewingSuggestion(Boolean(detail.isSuggestion));
    setShowingDiff(false);
    setDiffContent("");
  }

  function handleRevisionClose() {
    setViewingRevision(false);
    document.body.removeAttribute("data-revision");
    setRevisionNumber(null);
    setRevisionContent("");
    setViewingSuggestion(false);
    setShowingDiff(false);
    setDiffContent("");

    const query = new URLSearchParams(location.search);
    query.delete("revision");
    const search = query.toString();
    // `location.pathname` already carries the router base ("/{space}/"), so the
    // target must not be resolved against it again — that yields "/space/space/…".
    navigate(`${location.pathname}${search ? `?${search}` : ""}`, {
      replace: true,
      resolve: false,
    });
  }

  function closeRevisionView() {
    // Dispatch the event so DocumentContent also clears its viewingRevision flag
    window.dispatchEvent(new CustomEvent("revision:close"));
  }

  async function handleRevisionDiff(event: Event) {
    const detail = (event as CustomEvent).detail;
    const spaceId = currentSpaceId();
    if (!spaceId) return;

    try {
      const response = await fetch(
        `/api/v1/spaces/${spaceId}/documents/${props.documentId}/diff?rev=${detail.revision}&format=html`,
      );
      if (!response.ok) throw new Error("Failed to fetch diff");

      setDiffContent(await response.text());
      setShowingDiff(true);
      setViewingRevision(true);
      document.body.dataset.revision = "true";
      setRevisionNumber(detail.revision);
      setRevisionContent("");
      setViewingSuggestion(Boolean(detail.isSuggestion));
    } catch (error) {
      console.error("Failed to load diff:", error);
    }
  }

  onMount(() => {
    window.addEventListener("revision:view", handleRevisionView);
    window.addEventListener("revision:close", handleRevisionClose);
    window.addEventListener("revision:diff", handleRevisionDiff);

    onCleanup(() => {
      window.removeEventListener("revision:view", handleRevisionView);
      window.removeEventListener("revision:close", handleRevisionClose);
      window.removeEventListener("revision:diff", handleRevisionDiff);
    });
  });

  return (
    <Show when={viewingRevision()}>
      <div>
        {/* Revision Disclaimer Banner */}
        <BottomBanner>
          <div class="pointer-events-auto flex w-full flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 shadow-large sm:flex-row sm:items-center sm:justify-between">
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <Icon class="h-5 w-5 shrink-0 text-amber-600" name="activity" />
              <div class="min-w-0">
                <p class="font-semibold text-amber-900 text-size-medium">
                  {showingDiff() ? "Comparing" : "Viewing"}{" "}
                  {viewingSuggestion() ? "Suggestion" : "Revision"} {revisionNumber()}
                </p>
                <p class="my-0! flex flex-wrap items-center gap-3 text-amber-700 text-size-small">
                  <Switch
                    fallback={
                      <>
                        This is a historical version of the document. Changes cannot be
                        made.
                      </>
                    }
                  >
                    <Match when={showingDiff()}>
                      Changes from the published version are shown inline.
                      <span class="inline-flex items-center gap-2">
                        <span class="rounded-xs bg-green-100 px-1 text-green-700 no-underline">
                          added
                        </span>
                        <span class="rounded-xs bg-red-100 px-1 text-red-700 line-through">
                          removed
                        </span>
                      </span>
                    </Match>
                    <Match when={viewingSuggestion()}>
                      This suggestion is read-only until it is applied.
                    </Match>
                  </Switch>
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={closeRevisionView}
              class="shrink-0 rounded-sm border border-amber-300 bg-amber-100 px-4 py-2 font-medium text-amber-900 text-size-medium transition-colors hover:bg-amber-200"
            >
              Show published version
            </button>
          </div>
        </BottomBanner>

        {/* App Revision View (diffs render as an inline redline via document-view) */}
        <Show
          when={props.documentType === "app" && !showingDiff()}
          fallback={
            // Document / other type Revision View and inline diff
            <div>
              <document-view ref={setDocViewEl as never} />
            </div>
          }
        >
          <div class="h-full">
            <AppView html={revisionContent()} />
          </div>
        </Show>
      </div>
    </Show>
  );
}
