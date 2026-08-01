import type { CanvasShape } from "#canvas/extensions/types.ts";
import { isBrowserFindTarget } from "#canvas/model/shapeQueries.ts";
import type { Rect } from "#canvas/viewport/bounds.ts";
import type { WorldTransform } from "#canvas/viewport/transform.ts";
import type { FitReference } from "#canvas/viewport/types.ts";
import type { CanvasDomRefs } from "./CanvasView.ts";

/**
 * Where the canvas is looking.
 *
 * The camera is the canvas's entire scroll model — the viewport itself never
 * scrolls — so anything that wants to bring content into view goes through
 * here rather than touching the DOM.
 *
 * Everything it needs arrives in the context; it reaches for no globals except
 * the sidebar, which it measures because the visible region is narrower than
 * the viewport whenever that sidebar is docked.
 */
export interface CameraContext {
  state: {
    camera: { centerX: number; centerY: number; zoom: number };
    screen: { width: number; height: number };
    shapes: readonly CanvasShape[];
    strokes: readonly { points: readonly { x: number; y: number }[] }[];
  };
  dom: CanvasDomRefs;
  fitReference: FitReference;
  transform(): WorldTransform;
  shapeAabb(shape: CanvasShape): Rect;
  shapesById(): ReadonlyMap<string, CanvasShape>;
  /** False until the viewport has been measured; framing before that is wrong. */
  isReady(): boolean;
  /** Moving the camera changes every shape's position on screen. */
  invalidate(): void;
}

export function createCamera(context: CameraContext) {
  const { state, dom } = context;

  // Owned here rather than by the controller: only `fitInitialView` reads it,
  // and it exists to make that call happen exactly once per document.
  let hasFitInitialView = false;

  /**
   * How much of the viewport's left edge the docked sidebar covers.
   *
   * Content is centred in the part the reader can actually see, not in the
   * full viewport, or it sits half behind the sidebar.
   */
  function reservedSidebarWidth(): number {
    if (typeof window === "undefined") return 0;
    // Below the md breakpoint the sidebar is an overlay drawer and reserves no space.
    if (!window.matchMedia("(min-width: 768px)").matches) return 0;
    const rect = document.querySelector(".sidebar")?.getBoundingClientRect();
    return Math.max(0, rect?.right ?? 0);
  }

  function moveToShape(shape: CanvasShape) {
    const bounds = context.shapeAabb(shape);
    const inset = reservedSidebarWidth();
    const scale = context.transform().scale;
    state.camera = {
      ...state.camera,
      // Center within the unobscured part of the canvas, not behind the sidebar.
      centerX: bounds.x + bounds.width / 2 - inset / (2 * scale),
      centerY: bounds.y + bounds.height / 2,
    };
    context.invalidate();
  }

  function fitView(maxZoom = 5) {
    // Accumulated rather than spread into Math.min/max: a freehand stroke can
    // carry tens of thousands of points, which overflows the argument stack.
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let hasContent = false;

    for (const shape of state.shapes) {
      const bounds = context.shapeAabb(shape);
      if (bounds.x < minX) minX = bounds.x;
      if (bounds.y < minY) minY = bounds.y;
      if (bounds.x + bounds.width > maxX) maxX = bounds.x + bounds.width;
      if (bounds.y + bounds.height > maxY) maxY = bounds.y + bounds.height;
      hasContent = true;
    }
    for (const stroke of state.strokes) {
      for (const point of stroke.points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
        hasContent = true;
      }
    }

    const inset = reservedSidebarWidth();
    const baseScale = Math.min(
      state.screen.width / context.fitReference.width,
      state.screen.height / context.fitReference.height,
    );

    if (!hasContent) {
      // Center the world origin within the visible region (right of the nav).
      state.camera = { centerX: -inset / (2 * baseScale), centerY: 0, zoom: 1 };
      context.invalidate();
      return;
    }

    const width = Math.max(1, maxX - minX + 160);
    const height = Math.max(1, maxY - minY + 160);
    // Fit the content into the visible width, not the full (occluded) viewport.
    const availableWidth = Math.max(1, state.screen.width - inset);
    const fitScale = Math.min(availableWidth / width, state.screen.height / height);
    const zoom = Math.max(0.25, Math.min(maxZoom, fitScale / baseScale));
    const appliedScale = baseScale * zoom;

    state.camera = {
      // Shift the camera left by half the inset so the content centers in the
      // visible region rather than the full viewport.
      centerX: (minX + maxX) / 2 - inset / (2 * appliedScale),
      centerY: (minY + maxY) / 2,
      zoom,
    };
    context.invalidate();
  }

  /**
   * Frame the document the first time it has content, and never again.
   *
   * Content can arrive before or after the viewport is measured, so both the
   * Yjs sync and mount call this and whichever is second does the work.
   */
  function fitInitialView(isInitialContent: boolean) {
    if (hasFitInitialView || !context.isReady()) return;
    if (state.shapes.length === 0 && state.strokes.length === 0) return;
    hasFitInitialView = true;
    // Frame the content but never magnify past 100% on load.
    if (isInitialContent) fitView(1);
  }

  /**
   * Bring a shape revealed by the browser's own find-in-page into view.
   *
   * Shapes are marked `hidden=until-found` so native find can reach their text.
   */
  function handleBrowserFindMatch(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const article = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
    const shapeId = article?.dataset.shapeId;
    const shape = shapeId ? context.shapesById().get(shapeId) : null;
    if (!article || !shape || !isBrowserFindTarget(shape)) return;

    moveToShape(shape);

    // The browser removes hidden=until-found after beforematch. Restore the
    // marker once it has finished revealing this match so advancing to another
    // result in the same shape emits beforematch again. The author-level
    // content-visibility:auto rule keeps these marked shapes normally visible.
    requestAnimationFrame(() => {
      if (article.isConnected) article.setAttribute("hidden", "until-found");
      // Native find may try to scroll the overflow-hidden viewport as well as
      // revealing the match. Camera state is the canvas's only scroll model.
      dom.viewport?.scrollTo(0, 0);
    });
  }

  return { fitView, fitInitialView, moveToShape, handleBrowserFindMatch };
}
