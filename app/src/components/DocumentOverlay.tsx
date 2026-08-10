import { useNavigate } from "@solidjs/router";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { api } from "#api/client.ts";
import { useComments } from "#composeables/useComments.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import docStyles from "#editor/css/document.css?inline";
import { formatRelativeTime } from "#utils/datetime.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import "./AvatarElement.ts";
import { Icon } from "./Icon.tsx";

interface OverlayState {
  documentId: string;
  spaceId: string;
  slug?: string;
}

function formatCommentTime(date: Date | string): string {
  return formatRelativeTime(date, { style: "narrow", maxDays: 7 });
}

export function DocumentOverlay() {
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [documentData, setDocumentData] = createSignal<{
    title: string;
    content: string;
    slug: string;
    updatedAt: Date | string;
  } | null>(null);
  const [currentState, setCurrentState] = createSignal<OverlayState | null>(null);
  const [contentContainer, setContentContainer] = createSignal<HTMLElement | null>(null);
  const { currentSpaceId, spaces } = useSpace();

  const [hasMounted, setHasMounted] = createSignal(false);

  const { comments } = useComments({
    spaceId: () => currentState()?.spaceId,
    documentId: () => currentState()?.documentId,
  });

  async function openOverlay(spaceId: string, documentId: string) {
    setIsOpen(true);
    setLoading(true);
    setError(null);
    setDocumentData(null);
    setCurrentState({ spaceId, documentId });

    try {
      const doc = await api.document.get(spaceId, documentId);
      const title = doc.properties?.title;
      setDocumentData({
        title: title ? propertyValueToText(title) : "Untitled Document",
        content: doc.content || "",
        slug: doc.slug,
        updatedAt: doc.updatedAt,
      });
      setCurrentState({ spaceId, documentId, slug: doc.slug });
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to load document");
    } finally {
      setLoading(false);
    }
  }

  createEffect(() => {
    const container = contentContainer();
    const data = documentData();
    if (!container || !data) return;

    container.innerHTML = "";

    const docView = document.createElement("document-view");
    const shadow = docView.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = docStyles;
    shadow.appendChild(styleEl);

    const contentDiv = document.createElement("div");
    contentDiv.setAttribute("part", "content");
    contentDiv.innerHTML = data.content;
    shadow.appendChild(contentDiv);

    container.appendChild(docView);
  });

  function closeOverlay() {
    setIsOpen(false);
    setDocumentData(null);
    setCurrentState(null);
    setError(null);
  }

  function navigateToDocument() {
    const state = currentState();
    if (!state?.slug) return;

    if (state.spaceId !== currentSpaceId()) {
      const targetSpace = spaces()?.find((space) => space.id === state.spaceId);
      if (targetSpace) {
        window.location.href = `/${targetSpace.slug}/doc/${state.slug}`;
        return;
      }
    }

    navigate(`/doc/${state.slug}`);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && isOpen()) closeOverlay();
  }

  function handleViewDocumentEvent(event: Event) {
    const customEvent = event as CustomEvent<{ spaceId: string; documentId: string }>;
    void openOverlay(customEvent.detail.spaceId, customEvent.detail.documentId);
  }

  onMount(() => {
    setHasMounted(true);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("view-document", handleViewDocumentEvent);

    onCleanup(() => {
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("view-document", handleViewDocumentEvent);
    });
  });

  createEffect(
    on(
      isOpen,
      (open) => {
        document.body.style.overflow = open ? "hidden" : "";
      },
      { defer: true },
    ),
  );

  return (
    <Show when={hasMounted()}>
      <Portal>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a click-away backdrop; Escape and the close button are the keyboard paths. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the overlay, handled on document. */}
        <div
          hidden={!isOpen()}
          class="overlay-fade fixed inset-0 z-100 bg-black/30"
          onClick={closeOverlay}
        />

        <a-blur
          hidden={!isOpen()}
          enabled={isOpen()}
          on:exit={closeOverlay}
          class="overlay-slide fixed top-6 right-0 bottom-0 left-0 z-100 w-full min-w-[400px] overflow-hidden lg:top-0 lg:right-0 lg:bottom-0 lg:left-auto lg:max-w-[50vw]"
        >
          <drawer-track class="pointer-events-none h-full">
            <div class="pointer-events-none h-[calc(100vh-169px)] w-full flex-none lg:hidden" />

            <div class="pointer-events-auto flex h-full max-h-screen flex-1 flex-col bg-background">
              <div class="flex shrink-0 items-center justify-between border-neutral-100 border-b px-6 py-4">
                <div class="flex min-w-0 items-center gap-3">
                  <Icon class="h-5 w-5 shrink-0 text-neutral-400" name="document" />
                  <Show
                    when={documentData()}
                    fallback={
                      <Show when={loading()}>
                        <div class="h-6 w-48 animate-pulse rounded-sm bg-neutral-200" />
                      </Show>
                    }
                  >
                    {(data) => (
                      <h2 class="truncate font-semibold text-foreground text-size-title">
                        {data().title}
                      </h2>
                    )}
                  </Show>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <Show when={documentData()}>
                    <button
                      type="button"
                      onClick={navigateToDocument}
                      class="rounded-sm px-3 py-1.5 font-medium text-neutral-600 text-size-medium transition-colors hover:bg-neutral-100 hover:text-foreground"
                      title="Open full document"
                    >
                      Open
                    </button>
                  </Show>
                  <button
                    type="button"
                    onClick={closeOverlay}
                    class="rounded-sm p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-foreground"
                    title="Close (Esc)"
                  >
                    <Icon class="h-5 w-5" name="cancel" />
                  </button>
                </div>
              </div>

              <div class="flex-1 overflow-y-auto" data-scroll-container>
                <Show when={loading()}>
                  <div class="space-y-4 p-6">
                    <div class="h-4 w-3/4 animate-pulse rounded-sm bg-neutral-200" />
                    <div class="h-4 w-full animate-pulse rounded-sm bg-neutral-200" />
                    <div class="h-4 w-5/6 animate-pulse rounded-sm bg-neutral-200" />
                    <div class="h-4 w-2/3 animate-pulse rounded-sm bg-neutral-200" />
                  </div>
                </Show>

                <Show when={!loading() && error()}>
                  <div class="p-6 text-center">
                    <div class="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
                      <Icon class="h-6 w-6 text-red-600" name="warning-triangle" />
                    </div>
                    <p class="text-neutral-600">{error()}</p>
                    <button
                      type="button"
                      onClick={closeOverlay}
                      class="mt-4 rounded-sm border border-neutral-100 px-4 py-2 font-medium text-neutral-600 text-size-medium transition-colors hover:bg-neutral-50 hover:text-foreground"
                    >
                      Close
                    </button>
                  </div>
                </Show>

                <Show when={!loading() && !error() && documentData()}>
                  <div ref={setContentContainer} class="p-6" />
                </Show>

                <Show when={documentData()}>
                  <div class="border-neutral-100 border-t bg-neutral-50">
                    <div class="flex items-center gap-2 px-6 py-4">
                      <Icon class="h-4 w-4 text-neutral-600" name="comment" />
                      <h3 class="font-semibold text-foreground text-size-medium">
                        Comments ({comments().length})
                      </h3>
                    </div>

                    <div class="space-y-6 px-6 pb-6">
                      <Show when={comments().length === 0}>
                        <div class="py-8 text-center">
                          <p class="text-neutral-500 text-size-medium">
                            No comments yet.
                          </p>
                        </div>
                      </Show>

                      <For each={comments()}>
                        {(comment) => (
                          <div class="flex gap-3">
                            <vektor-avatar
                              size="small"
                              attr:user-id={comment.createdBy}
                              prop:user={comment.createdByUser}
                            />

                            <div class="min-w-0 flex-1">
                              <div class="flex items-baseline gap-2">
                                <span class="font-semibold text-foreground text-size-medium">
                                  {comment.createdByUser?.name || comment.createdBy}
                                </span>
                                <span class="text-neutral-500 text-size-small">
                                  {formatCommentTime(comment.createdAt)}
                                </span>
                              </div>

                              <div
                                class="mt-1 text-neutral-700 text-size-medium leading-relaxed [&_a]:text-primary-600 [&_a]:underline [&_em]:italic [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5"
                                innerHTML={renderMessageMarkdown(comment.content)}
                              />
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </div>
          </drawer-track>
        </a-blur>
      </Portal>
    </Show>
  );
}
