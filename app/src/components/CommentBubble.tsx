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
import { addIcon } from "#assets/icons.ts";
import {
  isInlineAnchorReference,
  resolveReferenceSelector,
  useComments,
} from "#composeables/useComments.solid.ts";
import { CommentThread, type Comment as CommentThreadType } from "./CommentThread.tsx";

/** Vue's `defineExpose`, as a callback prop (plan §10). */
export interface CommentBubbleHandle {
  commentsForOverlays: () => Array<{
    id: string;
    reference?: string;
    createdBy: string;
    createdByUser?: ApiComment["createdByUser"];
  }>;
  handleMoveThread: (payload: { reference: string; y: number }) => Promise<void>;
  handleThreadReposition: () => void;
}

interface Props {
  spaceId: string;
  documentId: string;
  currentRev?: number;
  editor?: Editor;
  ref?: (handle: CommentBubbleHandle) => void;
}

const EDGE_THRESHOLD_PX = 60;
const COMMENT_BUBBLE_PROXIMITY_PX = 20;
const THREAD_GAP_PX = 8;

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
  const [addingCommentY, setAddingCommentY] = createSignal<number | null>(null);
  const [addingCommentRef, setAddingCommentRef] = createSignal<string | null>(null);
  const [fadeAddBubble, setFadeAddBubble] = createSignal(false);

  // Inline anchor click tooltip
  const [clickedAnchorRef, setClickedAnchorRef] = createSignal<string | null>(null);
  const [tooltipPos, setTooltipPos] = createSignal({ top: 0, left: 0 });
  let tooltipEl: HTMLDivElement | undefined;

  // The bubbles portal into <body>, which does not exist during SSR. A flag set
  // after mount (rather than `isServer`) keeps hydrated markup identical.
  const [hasMounted, setHasMounted] = createSignal(false);

  // Thread anchor derived from the comment bubble the thread belongs to,
  // so the thread stays attached to the bubble instead of the viewport edge.
  const [threadAnchor, setThreadAnchor] = createSignal<{
    top: number;
    right: number;
  } | null>(null);

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
      // Click outside tooltip closes it
      if (tooltipEl && !tooltipEl.contains(e.target as Node)) setClickedAnchorRef(null);
      return;
    }
    const ref = `[data-comment-id="${hit.commentId}"]`;
    // Toggle off if clicking the same anchor again
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
    const rect = bubble.getBoundingClientRect();
    setThreadAnchor({
      top: rect.top,
      right: window.innerWidth - rect.left + THREAD_GAP_PX,
    });
  }

  function handleThreadReposition() {
    if (!activeReference()) return;
    requestAnimationFrame(updateThreadAnchor);
  }

  createEffect(
    on(activeReference, () => {
      // The bubble overlay has already rendered; Solid applies writes
      // synchronously, so there is no tick to await before measuring.
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

  function handleMouseMove(e: MouseEvent) {
    if (activeReference() || addingCommentY() !== null) {
      setShowAddBubble(false);
      setFadeAddBubble(false);
      return;
    }

    if (e.clientX > window.innerWidth - EDGE_THRESHOLD_PX && e.clientY > 200) {
      setShowAddBubble(true);
      setBubbleY(e.clientY);
      setFadeAddBubble(isNearCommentBubble(e.clientX, e.clientY));
    } else {
      setShowAddBubble(false);
      setFadeAddBubble(false);
    }
  }

  function handleAddComment() {
    // Viewport y for the fixed-positioned thread popup
    setAddingCommentY(bubbleY());
    // Stored reference is the y offset relative to the document content,
    // so the bubble stays anchored regardless of scroll position.
    const docView = document.querySelector("document-view");
    const docTop = docView ? docView.getBoundingClientRect().top : 0;
    setAddingCommentRef(String(Math.max(0, Math.round(bubbleY() - docTop))));
    setShowAddBubble(false);
    setFadeAddBubble(false);
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

  function handleMouseLeave() {
    setShowAddBubble(false);
    setFadeAddBubble(false);
  }

  onMount(() => {
    setHasMounted(true);
    setupListeners();
    window.addEventListener("mousemove", handleMouseMove);
    document.documentElement.addEventListener("mouseleave", handleMouseLeave);
    // Capture phase so scrolls inside nested containers also re-anchor the thread.
    window.addEventListener("scroll", handleThreadReposition, true);
    window.addEventListener("resize", handleThreadReposition);
    window.addEventListener("editor-update", handleThreadReposition);
    // Inline anchor click detection — composedPath pierces the shadow DOM.
    document.addEventListener("click", handleDocumentClick);

    onCleanup(() => {
      cleanupListeners();
      window.removeEventListener("mousemove", handleMouseMove);
      document.documentElement.removeEventListener("mouseleave", handleMouseLeave);
      window.removeEventListener("scroll", handleThreadReposition, true);
      window.removeEventListener("resize", handleThreadReposition);
      window.removeEventListener("editor-update", handleThreadReposition);
      document.removeEventListener("click", handleDocumentClick);
    });
  });

  props.ref?.({ commentsForOverlays, handleMoveThread, handleThreadReposition });

  return (
    <Show when={hasMounted()}>
      <Portal>
        <div class="contents">
          {/* Add comment bubble — appears near right viewport edge */}
          <Show when={showAddBubble()}>
            <div
              class="fixed right-4 z-50 -translate-y-1/2 transition-opacity duration-200"
              classList={{
                "pointer-events-none opacity-0": fadeAddBubble(),
                "pointer-events-auto opacity-100": !fadeAddBubble(),
              }}
              style={{ top: `${bubbleY()}px` }}
            >
              <button
                type="button"
                onClick={handleAddComment}
                class="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-500 shadow-md transition-all hover:border-primary-300 hover:text-primary-600 hover:shadow-lg"
                title="Add comment"
              >
                <div class="svg-icon h-4 w-4" innerHTML={addIcon} />
              </button>
            </div>
          </Show>

          {/* Thread for existing comment reference — anchored to its comment bubble */}
          <Show when={activeReference()}>
            {(reference) => (
              <div
                class="fixed z-40"
                style={
                  threadAnchor()
                    ? {
                        top: `${threadAnchor()?.top}px`,
                        right: `${threadAnchor()?.right}px`,
                      }
                    : { top: `${threadPosition()}px`, right: "1rem" }
                }
              >
                <CommentThread
                  spaceId={props.spaceId}
                  documentId={props.documentId}
                  comments={commentsForThread()}
                  activeReference={reference()}
                  isSubmitting={isSubmitting()}
                  isDeletingComment={isDeletingComment()}
                  onSubmit={(payload) => void handleSubmit(payload)}
                  onDelete={(id) => void handleDeleteComment(id)}
                  onResolve={() => void handleResolve(reference())}
                  onClose={handleCloseThread}
                />
              </div>
            )}
          </Show>

          {/* Thread for new comment (bubble click) */}
          <Show when={addingCommentY() !== null && !activeReference()}>
            <div class="fixed right-4 z-40" style={{ top: `${addingCommentY()}px` }}>
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

          {/* Inline anchor click tooltip */}
          <Show when={clickedAnchorRef() && !activeReference()}>
            {(_) => {
              const anchor = clickedAnchorRef();
              if (!anchor) return null;
              return (
                <div
                  ref={tooltipEl}
                  class="fixed z-40"
                  style={{
                    top: `${tooltipPos().top}px`,
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
