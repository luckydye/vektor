import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import {
  isInlineAnchorReference,
  isPositionReference,
  resolveReferenceSelector,
} from "#composeables/useComments.solid.ts";
import "./AvatarElement.ts";

interface CommentUser {
  id: string;
  name: string | null;
  image: string | null;
}

export interface Comment {
  id: string;
  reference?: string;
  createdBy: string;
  createdByUser?: CommentUser | null;
}

interface Props {
  comments: Comment[];
  onMove?: (payload: { reference: string; y: number }) => void;
  onPositioned?: () => void;
}

interface CommentParticipant {
  key: string;
  userId: string;
  user: CommentUser | null;
}

interface CommentOverlay {
  top: number;
  count: number;
  reference: string;
  participants: CommentParticipant[];
}

const MAX_VISIBLE_AVATARS = 3;
const DRAG_THRESHOLD_PX = 4;

function findElement(reference: string, root: Element | ShadowRoot): Element | null {
  // Case 1: Reference is an ID
  const byId =
    root instanceof ShadowRoot
      ? root.getElementById(reference)
      : root.querySelector(`#${reference}`);
  if (byId) return byId;

  // Case 2: Reference is a selector (e.g. "p:nth-of-type(1)")
  try {
    const bySelector = root.querySelector(reference);
    if (bySelector) return bySelector;
  } catch {}

  return null;
}

export function CommentOverlays(props: Props) {
  let containerEl: HTMLDivElement | undefined;

  // A store rather than a signal: dragging writes a single overlay's `top` in
  // place, and only that bubble should move.
  const [overlays, setOverlays] = createStore<CommentOverlay[]>([]);

  const [drag, setDrag] = createSignal<{
    reference: string;
    startY: number;
    startTop: number;
    moved: boolean;
  } | null>(null);
  let suppressClick = false;

  /** Top of the document content relative to the overlay container. */
  function documentViewTop(): number {
    const docView = document.querySelector("document-view");
    if (!containerEl || !docView) return 0;
    return docView.getBoundingClientRect().top - containerEl.getBoundingClientRect().top;
  }

  function updateOverlays() {
    if (drag()?.moved) return; // don't snap bubbles back mid-drag

    const docView = document.querySelector("document-view");
    if (!containerEl || !docView) return;

    // Group comments and their distinct authors by reference.
    const commentGroups = new Map<string, Comment[]>();
    for (const c of props.comments) {
      if (!c.reference) continue;
      const reference = resolveReferenceSelector(c.reference);
      const group = commentGroups.get(reference) ?? [];
      group.push(c);
      commentGroups.set(reference, group);
    }

    const containerRect = containerEl.getBoundingClientRect();
    const docTop = docView.getBoundingClientRect().top - containerRect.top;
    const searchRoot = docView.shadowRoot ?? docView;

    const newOverlays: CommentOverlay[] = [];

    commentGroups.forEach((comments, reference) => {
      // Inline anchor comments are shown as hover tooltips, not right-edge bubbles.
      if (isInlineAnchorReference(reference)) return;

      const participants = Array.from(
        comments
          .reduce((byUser, comment) => {
            const userId = comment.createdByUser?.id ?? comment.createdBy;
            // Optimistic comments have no author until the server responds, so their
            // comment id keeps their temporary avatar separate from another pending one.
            const key = userId || comment.id;
            if (!byUser.has(key)) {
              byUser.set(key, { key, userId, user: comment.createdByUser ?? null });
            }
            return byUser;
          }, new Map<string, CommentParticipant>())
          .values(),
      );
      const overlay = { count: comments.length, reference, participants };

      if (isPositionReference(reference)) {
        // Position references are y offsets relative to the document content
        newOverlays.push({ ...overlay, top: docTop + Number(reference) });
        return;
      }

      const target = findElement(reference, searchRoot);
      if (target) {
        // Calculate top relative to the overlay container
        const top = target.getBoundingClientRect().top - containerRect.top;
        newOverlays.push({ ...overlay, top });
      }
    });

    setOverlays(newOverlays);
    // Consumers anchored to a bubble measure after it has moved in the DOM.
    // Solid applies the store write synchronously, so there is no tick to await.
    props.onPositioned?.();
  }

  function handleResize() {
    requestAnimationFrame(updateOverlays);
  }

  function openSidebar(reference: string) {
    window.dispatchEvent(new CustomEvent("comment:create", { detail: { reference } }));
  }

  // --- Drag-to-reposition ---

  function startDrag(e: PointerEvent, overlay: CommentOverlay) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      reference: overlay.reference,
      startY: e.clientY,
      startTop: overlay.top,
      moved: false,
    });
  }

  function onDragMove(e: PointerEvent, index: number, overlay: CommentOverlay) {
    const d = drag();
    if (!d || d.reference !== overlay.reference) return;

    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < DRAG_THRESHOLD_PX) return;

    setDrag({ ...d, moved: true });
    setOverlays(index, "top", d.startTop + dy);
  }

  function endDrag(overlay: CommentOverlay) {
    const d = drag();
    setDrag(null);
    if (!d || d.reference !== overlay.reference || !d.moved) return;

    // Inline anchor references are bound to document text — don't convert to a y-offset.
    if (isInlineAnchorReference(d.reference)) return;

    suppressClick = true;
    const y = Math.max(0, Math.round(overlay.top - documentViewTop()));
    props.onMove?.({ reference: d.reference, y });
  }

  function handleClick(reference: string) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    openSidebar(reference);
  }

  createEffect(on(() => props.comments, updateOverlays));

  onMount(() => {
    let resizeObserver: ResizeObserver | null = null;

    window.addEventListener("resize", handleResize);
    // The overlay stores positions relative to its container, while document
    // anchors are measured in the viewport. Recalculate on every captured
    // scroll so bubbles stay attached when either the page or a nested pane
    // scrolls.
    window.addEventListener("scroll", handleResize, true);
    // Recompute when the document content grows/shrinks (images loading,
    // entering/leaving edit mode, ...). The container is inset-0, so it
    // tracks the wrapper around the document content.
    if (containerEl && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(containerEl);
    }
    window.addEventListener("editor-update", handleResize);
    handleResize();

    onCleanup(() => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleResize, true);
      window.removeEventListener("editor-update", handleResize);
      resizeObserver?.disconnect();
      resizeObserver = null;
    });
  });

  return (
    <div
      ref={containerEl}
      class="pointer-events-none absolute inset-0 right-0 overflow-visible"
    >
      <For each={overlays}>
        {(overlay, index) => (
          <button
            type="button"
            onPointerDown={(e) => startDrag(e, overlay)}
            onPointerMove={(e) => onDragMove(e, index(), overlay)}
            onPointerUp={() => endDrag(overlay)}
            onPointerCancel={() => setDrag(null)}
            onClick={(e) => {
              e.stopPropagation();
              handleClick(overlay.reference);
            }}
            data-comment-overlay-bubble="true"
            data-comment-reference={overlay.reference}
            class="pointer-events-auto absolute right-0 z-20 flex min-h-10 touch-none select-none items-center rounded-full px-1 transition-colors duration-200 hover:text-primary-600 hover:ring-2 hover:ring-primary-100"
            classList={{
              "cursor-grabbing shadow-lg":
                drag()?.reference === overlay.reference && !!drag()?.moved,
              "cursor-pointer":
                !(drag()?.reference === overlay.reference && drag()?.moved) &&
                isInlineAnchorReference(overlay.reference),
              "cursor-grab":
                !(drag()?.reference === overlay.reference && drag()?.moved) &&
                !isInlineAnchorReference(overlay.reference),
            }}
            style={{ top: `${overlay.top}px` }}
            title={`${overlay.count} comment${overlay.count === 1 ? "" : "s"}${
              isInlineAnchorReference(overlay.reference) ? "" : " — drag to reposition"
            }`}
            aria-label={`View ${overlay.count} comment${overlay.count === 1 ? "" : "s"}`}
          >
            <span class="flex items-center py-1">
              <For each={overlay.participants.slice(0, MAX_VISIBLE_AVATARS)}>
                {(participant, avatarIndex) => (
                  <span classList={{ "-ml-4": avatarIndex() > 0 }}>
                    <vektor-avatar
                      size="36"
                      attr:user-id={participant.userId}
                      prop:user={participant.user}
                      class="pointer-events-none"
                    />
                  </span>
                )}
              </For>
              <Show when={overlay.participants.length > MAX_VISIBLE_AVATARS}>
                <span class="absolute -right-1 -bottom-1 flex h-6 min-w-6 items-center justify-center rounded-full border border-neutral-200 bg-white px-1 font-semibold text-[10px] text-neutral-700 shadow-sm">
                  +{overlay.participants.length - MAX_VISIBLE_AVATARS}
                </span>
              </Show>
            </span>
          </button>
        )}
      </For>
    </div>
  );
}
