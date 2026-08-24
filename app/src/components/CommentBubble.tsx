import type { Editor } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { Comment as ApiComment } from "#api/ApiClient.ts";
import {
  isInlineAnchorReference,
  resolveReferenceSelector,
  useComments,
} from "#composeables/useComments.ts";
import { CommentThread, type Comment as CommentThreadType } from "./CommentThread.tsx";
import { Icon } from "./Icon.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

export interface CommentBubbleHandle {
  commentsForOverlays: () => Array<{
    id: string;
    reference?: string;
    createdBy: string;
    createdByUser?: ApiComment["createdByUser"];
  }>;
  handleMoveThread: (payload: { reference: string; y: number }) => Promise<void>;
  handleThreadReposition: () => void;
  /** Which thread is open, so its bubble can render as the selected one. */
  activeReference: () => string | null;
}

interface Props {
  spaceId: string;
  documentId: string;
  currentRev?: number;
  editor?: Editor;
  documentView?: HTMLElement | null;
  ref?: (handle: CommentBubbleHandle) => void;
}

const EDGE_THRESHOLD_PX = 60;
const COMMENT_BUBBLE_PROXIMITY_PX = 20;
const THREAD_GAP_PX = 8;
// Clears the image resize handle, which overhangs the document edge by 20px.
const ADD_BUBBLE_GAP_PX = 28;
const ADD_BUBBLE_SIZE_PX = 32;
const VIEWPORT_MARGIN_PX = 8;
const ADD_BUBBLE_REACH_PX = 12;
const HIDE_GRACE_MS = 400;

/**
 * Where an element sits in layout, ignoring any transform on it.
 *
 * A bubble carries a press squish and a drag lift, and `getBoundingClientRect`
 * reports the painted box: anchoring to that pins the panel to whichever frame
 * of the animation was current, and it shifts as soon as anything re-measures.
 */
function layoutOrigin(el: HTMLElement): { top: number; left: number } {
  const parent = el.offsetParent as HTMLElement | null;
  if (!parent) {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, left: rect.left };
  }
  const parentRect = parent.getBoundingClientRect();
  return {
    top: parentRect.top + parent.clientTop + el.offsetTop,
    left: parentRect.left + parent.clientLeft + el.offsetLeft,
  };
}

/**
 * Holds a panel inside the viewport: it keeps the anchor it was given while it
 * fits, and rides up by exactly the overflow when it does not.
 */
function useViewportFit() {
  const [height, setHeight] = createSignal(0);

  const ref = (el: HTMLElement) => {
    if (typeof ResizeObserver === "undefined") return;
    // Measured rather than assumed: a thread grows as replies arrive, and the
    // clamp has to follow it without waiting for a scroll or resize event.
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };

  const top = (anchor: number) => {
    const lowest = window.innerHeight - VIEWPORT_MARGIN_PX - height();
    return Math.max(VIEWPORT_MARGIN_PX, Math.min(anchor, lowest));
  };

  return { ref, top };
}

function toThreadComment(c: ApiComment): CommentThreadType {
  return {
    id: c.id,
    content: c.content,
    createdAt: typeof c.createdAt === "string" ? c.createdAt : c.createdAt.toISOString(),
    createdBy: c.createdBy,
    createdByUser: c.createdByUser,
    reference: c.reference ?? undefined,
    parentId: c.parentId ?? undefined,
  } as CommentThreadType;
}

export function CommentBubble(props: Props) {
  const t = useTranslation();

  const {
    comments,
    activeReference,
    setActiveReference,
    threadPosition,
    isSubmitting,
    isDeletingComment,
    activeComments,
    submitComment,
    deleteComment,
    moveThread,
    resolveThread,
    setupListeners,
    cleanupListeners,
  } = useComments({
    spaceId: () => props.spaceId,
    documentId: () => props.documentId,
    currentRev: () => props.currentRev,
  });

  const [showAddBubble, setShowAddBubble] = createSignal(false);
  const [bubbleY, setBubbleY] = createSignal(0);
  const [bubbleX, setBubbleX] = createSignal(0);
  const [addingCommentY, setAddingCommentY] = createSignal<number | null>(null);
  const [addingCommentX, setAddingCommentX] = createSignal(0);
  const [addingCommentRef, setAddingCommentRef] = createSignal<string | null>(null);
  const [fadeAddBubble, setFadeAddBubble] = createSignal(false);

  const [clickedAnchorRef, setClickedAnchorRef] = createSignal<string | null>(null);
  const [tooltipPos, setTooltipPos] = createSignal({ top: 0, left: 0 });
  let tooltipEl: HTMLDivElement | undefined;

  const [hasMounted, setHasMounted] = createSignal(false);

  const [threadAnchor, setThreadAnchor] = createSignal<{
    top: number;
    right: number;
  } | null>(null);

  const threadFit = useViewportFit();
  const composeFit = useViewportFit();
  const anchorTooltipFit = useViewportFit();

  function anchorFromPath(e: MouseEvent): { el: HTMLElement; commentId: string } | null {
    for (const node of e.composedPath()) {
      if (node instanceof HTMLElement && node.dataset.commentId) {
        return { el: node, commentId: node.dataset.commentId };
      }
    }
    return null;
  }

  function handleDocumentClick(e: MouseEvent) {
    const hit = anchorFromPath(e);
    if (!hit) {
      if (tooltipEl && !tooltipEl.contains(e.target as Node)) setClickedAnchorRef(null);
      return;
    }
    const ref = `[data-comment-id="${hit.commentId}"]`;
    if (clickedAnchorRef() === ref) {
      setClickedAnchorRef(null);
      return;
    }
    setClickedAnchorRef(ref);
    const rect = hit.el.getBoundingClientRect();
    const tooltipWidth = 320;
    setTooltipPos({
      top: rect.bottom + 6,
      left: Math.min(rect.left, window.innerWidth - tooltipWidth - 8),
    });
  }

  function bubbleForReference(reference: string): HTMLElement | null {
    const bubbles = document.querySelectorAll<HTMLElement>(
      "[data-comment-overlay-bubble='true']",
    );
    return (
      Array.from(bubbles).find((b) => b.dataset.commentReference === reference) ?? null
    );
  }

  function updateThreadAnchor() {
    const reference = activeReference();
    if (!reference) {
      setThreadAnchor(null);
      return;
    }
    const bubble = bubbleForReference(reference);
    if (!bubble) {
      setThreadAnchor(null);
      return;
    }
    const origin = layoutOrigin(bubble);
    setThreadAnchor({
      top: origin.top,
      right: window.innerWidth - origin.left + THREAD_GAP_PX,
    });
  }

  function handleThreadReposition() {
    if (!activeReference()) return;
    requestAnimationFrame(updateThreadAnchor);
  }

  createEffect(
    on(activeReference, () => {
      updateThreadAnchor();
    }),
  );

  const commentsForOverlays = createMemo(() =>
    comments().map((c: ApiComment) => ({
      id: c.id,
      reference: c.reference ?? undefined,
      createdBy: c.createdBy,
      createdByUser: c.createdByUser,
    })),
  );

  const clickedAnchorComments = createMemo(() => {
    const anchor = clickedAnchorRef();
    if (!anchor) return [];
    return comments()
      .filter(
        (c: ApiComment) =>
          c.reference && resolveReferenceSelector(c.reference) === anchor,
      )
      .map(toThreadComment);
  });

  const commentsForThread = createMemo(() => activeComments().map(toThreadComment));

  function isNearCommentBubble(cursorX: number, cursorY: number) {
    const bubbles = document.querySelectorAll<HTMLElement>(
      "[data-comment-overlay-bubble='true']",
    );

    return Array.from(bubbles).some((bubble) => {
      const rect = bubble.getBoundingClientRect();
      return (
        cursorX >= rect.left - COMMENT_BUBBLE_PROXIMITY_PX &&
        cursorX <= rect.right + COMMENT_BUBBLE_PROXIMITY_PX &&
        cursorY >= rect.top - COMMENT_BUBBLE_PROXIMITY_PX &&
        cursorY <= rect.bottom + COMMENT_BUBBLE_PROXIMITY_PX
      );
    });
  }

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function cancelHide() {
    if (hideTimer === undefined) return;
    clearTimeout(hideTimer);
    hideTimer = undefined;
  }

  function hideAddBubble() {
    cancelHide();
    setShowAddBubble(false);
    setFadeAddBubble(false);
  }

  function scheduleHideAddBubble() {
    cancelHide();
    hideTimer = setTimeout(hideAddBubble, HIDE_GRACE_MS);
  }

  function handleDocumentPointerMove(e: PointerEvent) {
    if (e.pointerType === "touch") return;

    const docView = props.documentView; // solid-reactivity-ok: handler, re-reads per call
    if (!docView || activeReference() || addingCommentY() !== null) {
      hideAddBubble();
      return;
    }

    const rect = docView.getBoundingClientRect();
    if (e.clientX < rect.right - EDGE_THRESHOLD_PX) {
      hideAddBubble();
      return;
    }

    const left = Math.min(
      rect.right + ADD_BUBBLE_GAP_PX,
      window.innerWidth - ADD_BUBBLE_SIZE_PX - VIEWPORT_MARGIN_PX,
    );

    cancelHide();
    setShowAddBubble(true);
    setBubbleY(e.clientY);
    setBubbleX(left);
    setFadeAddBubble(isNearCommentBubble(left + ADD_BUBBLE_SIZE_PX / 2, e.clientY));
  }

  function isNearAddBubble(x: number, y: number) {
    // Reach back to the document edge so the gap the cursor crosses stays live.
    const docView = props.documentView; // solid-reactivity-ok: handler, re-reads per call
    const docRight = docView?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY;
    return (
      x >= Math.min(docRight, bubbleX() - ADD_BUBBLE_REACH_PX) &&
      x <= bubbleX() + ADD_BUBBLE_SIZE_PX + ADD_BUBBLE_REACH_PX &&
      y >= bubbleY() - ADD_BUBBLE_SIZE_PX / 2 - ADD_BUBBLE_REACH_PX &&
      y <= bubbleY() + ADD_BUBBLE_SIZE_PX / 2 + ADD_BUBBLE_REACH_PX
    );
  }

  function handleWindowPointerMove(e: PointerEvent) {
    if (!showAddBubble()) return;
    if (isNearAddBubble(e.clientX, e.clientY)) {
      cancelHide();
      return;
    }
    const docView = props.documentView; // solid-reactivity-ok: handler, re-reads per call
    if (docView && !e.composedPath().includes(docView)) hideAddBubble();
  }

  function handleAddComment() {
    setAddingCommentY(bubbleY());
    setAddingCommentX(bubbleX());
    const docView = props.documentView; // solid-reactivity-ok: handler, re-reads per call
    const docTop = docView ? docView.getBoundingClientRect().top : 0;
    setAddingCommentRef(String(Math.max(0, Math.round(bubbleY() - docTop))));
    hideAddBubble();
  }

  async function handleSubmit(payload: { content: string; reference: string | null }) {
    await submitComment(payload.content, payload.reference);
  }

  async function handleSubmitNew(payload: { content: string; reference: string | null }) {
    await submitComment(payload.content, payload.reference);
    setAddingCommentY(null);
    setAddingCommentRef(null);
  }

  async function handleMoveThread(payload: { reference: string; y: number }) {
    await moveThread(payload.reference, payload.y);
  }

  async function handleDeleteComment(commentId: string) {
    await deleteComment(commentId);
  }

  function removeCommentAnchorMark(reference: string) {
    const editor = props.editor; // solid-reactivity-ok: handler, re-reads per call
    if (!editor || editor.isDestroyed) return;
    const match = reference.match(/\[data-comment-id="([^"]+)"\]/);
    if (!match) return;
    const commentId = match[1];
    const { state, view } = editor;
    const tr = state.tr;
    let modified = false;
    state.doc.descendants((node: ProseMirrorNode, pos: number) => {
      if (!node.isText) return;
      const mark = node.marks.find(
        (m: Mark) => m.type.name === "commentAnchor" && m.attrs.commentId === commentId,
      );
      if (mark) {
        tr.removeMark(pos, pos + node.nodeSize, mark.type);
        modified = true;
      }
    });
    if (modified) view.dispatch(tr);
  }

  async function handleResolve(reference: string | null) {
    if (!reference) return;
    await resolveThread(reference);
    if (isInlineAnchorReference(reference)) removeCommentAnchorMark(reference);
    setClickedAnchorRef(null);
  }

  function handleCloseThread() {
    const reference = activeReference();
    if (
      reference &&
      isInlineAnchorReference(reference) &&
      commentsForThread().length === 0
    ) {
      removeCommentAnchorMark(reference);
    }
    setActiveReference(null);
  }

  createEffect(() => {
    const docView = props.documentView; // solid-reactivity-ok: effect re-runs and rebinds when it changes
    if (!docView) return;
    docView.addEventListener("pointermove", handleDocumentPointerMove);
    docView.addEventListener("pointerleave", scheduleHideAddBubble);
    window.addEventListener("pointermove", handleWindowPointerMove);
    onCleanup(() => {
      docView.removeEventListener("pointermove", handleDocumentPointerMove);
      docView.removeEventListener("pointerleave", scheduleHideAddBubble);
      window.removeEventListener("pointermove", handleWindowPointerMove);
      hideAddBubble();
    });
  });

  onMount(() => {
    setHasMounted(true);
    setupListeners();
    window.addEventListener("scroll", handleThreadReposition, true);
    window.addEventListener("resize", handleThreadReposition);
    window.addEventListener("editor-update", handleThreadReposition);
    document.addEventListener("click", handleDocumentClick);

    onCleanup(() => {
      cleanupListeners();
      cancelHide();
      window.removeEventListener("scroll", handleThreadReposition, true);
      window.removeEventListener("resize", handleThreadReposition);
      window.removeEventListener("editor-update", handleThreadReposition);
      document.removeEventListener("click", handleDocumentClick);
    });
  });

  props.ref?.({
    commentsForOverlays,
    handleMoveThread,
    handleThreadReposition,
    activeReference,
  });

  return (
    <Show when={hasMounted()}>
      <Portal>
        <div class="contents">
          <Show when={showAddBubble()}>
            <div
              class="fixed z-50 -translate-y-1/2 transition-opacity duration-200"
              classList={{
                "pointer-events-none opacity-0": fadeAddBubble(),
                "pointer-events-auto opacity-100": !fadeAddBubble(),
              }}
              style={{ top: `${bubbleY()}px`, left: `${bubbleX()}px` }}
              onPointerEnter={cancelHide}
              onPointerLeave={scheduleHideAddBubble}
            >
              <button
                type="button"
                onClick={handleAddComment}
                class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-background text-neutral-500 shadow-md transition-all hover:border-primary-300 hover:text-primary-600 hover:shadow-lg"
                title={t("Add comment")}
              >
                <Icon class="h-4 w-4" name="add" />
              </button>
            </div>
          </Show>

          <Show keyed when={activeReference()}>
            {(reference) => (
              <div
                ref={threadFit.ref}
                class="comment-thread-enter fixed z-40"
                style={
                  threadAnchor()
                    ? {
                        top: `${threadFit.top(threadAnchor()?.top ?? 0)}px`,
                        right: `${threadAnchor()?.right}px`,
                      }
                    : { top: `${threadFit.top(threadPosition())}px`, right: "1rem" }
                }
              >
                <CommentThread
                  spaceId={props.spaceId}
                  documentId={props.documentId}
                  comments={commentsForThread()}
                  activeReference={reference}
                  isSubmitting={isSubmitting()}
                  isDeletingComment={isDeletingComment()}
                  onSubmit={(payload) => void handleSubmit(payload)}
                  onDelete={(id) => void handleDeleteComment(id)}
                  onResolve={() => void handleResolve(reference)}
                  onClose={handleCloseThread}
                />
              </div>
            )}
          </Show>

          <Show when={addingCommentY() !== null && !activeReference()}>
            <div
              ref={composeFit.ref}
              class="comment-thread-enter fixed z-40"
              style={{
                top: `${composeFit.top(addingCommentY() ?? 0)}px`,
                right: `${window.innerWidth - addingCommentX() + THREAD_GAP_PX}px`,
              }}
            >
              <CommentThread
                spaceId={props.spaceId}
                documentId={props.documentId}
                comments={[]}
                activeReference={addingCommentRef()}
                isSubmitting={isSubmitting()}
                isDeletingComment={isDeletingComment()}
                onSubmit={(payload) => void handleSubmitNew(payload)}
                onDelete={(id) => void handleDeleteComment(id)}
                onClose={() => {
                  setAddingCommentY(null);
                  setAddingCommentRef(null);
                }}
              />
            </div>
          </Show>

          <Show when={clickedAnchorRef() && !activeReference()}>
            {(_) => {
              const anchor = clickedAnchorRef();
              if (!anchor) return null;
              return (
                <div
                  ref={(el) => {
                    tooltipEl = el;
                    anchorTooltipFit.ref(el);
                  }}
                  class="comment-thread-enter fixed z-40"
                  style={{
                    top: `${anchorTooltipFit.top(tooltipPos().top)}px`,
                    left: `${tooltipPos().left}px`,
                  }}
                >
                  <CommentThread
                    spaceId={props.spaceId}
                    documentId={props.documentId}
                    comments={clickedAnchorComments()}
                    activeReference={anchor}
                    isSubmitting={isSubmitting()}
                    isDeletingComment={isDeletingComment()}
                    onSubmit={(payload) => void handleSubmit(payload)}
                    onDelete={(id) => void handleDeleteComment(id)}
                    onResolve={() => void handleResolve(anchor)}
                    onClose={() => setClickedAnchorRef(null)}
                  />
                </div>
              );
            }}
          </Show>
        </div>
      </Portal>
    </Show>
  );
}
