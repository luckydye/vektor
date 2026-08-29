import type { CanvasElementTransform } from "#canvas/runtime/extensionApi.ts";
import type { Rect } from "#canvas/runtime/geometry.ts";
import { unionBounds } from "#canvas/runtime/geometry.ts";

/**
 * What is selected, and what the selection can be asked to do.
 *
 * Shapes and strokes live in separate stores — a board holds tens of shapes and
 * can hold thousands of strokes, and the stroke list is deliberately kept cheap
 * — but nothing here cares which store an id came from. The engine resolves an
 * id to a `CanvasElementHandle`, and this asks the handle.
 *
 * Touches neither the DOM nor a framework: it is a question about a set of ids
 * and a lookup, so it can be answered the same way from a component, the
 * custom-element host, or a test.
 */

export type CanvasElementKind = "shape" | "stroke";

/** One selectable thing, whichever store it came from. */
export interface CanvasElementHandle {
  id: string;
  kind: CanvasElementKind;
  /** The extension type for a shape; the stroke's own kind for ink. */
  type: string;
  locked: boolean;
  /** False when locked, and when the element belongs to another user. */
  canMove: boolean;
  /** Axis-aligned world bounds, rotation included. Null when it has none. */
  bounds: Rect | null;
  /** Degrees. Strokes bake rotation into their points and record it here. */
  rotation: number;
  transform: CanvasElementTransform;
  /**
   * Whether selecting this alone offers grab handles.
   *
   * Separate from `transform` because the two are not the same question:
   * freehand ink scales perfectly well as part of a group but has no box of its
   * own worth grabbing, so it is scalable without being handled.
   */
  handles: boolean;
}

export interface SelectionContext {
  selectedIds: ReadonlySet<string>;
  element: (id: string) => CanvasElementHandle | null;
}

export interface ScalableSelection {
  elements: CanvasElementHandle[];
  bounds: Rect;
}

/** The selected ids resolved, dropping any that no longer exist. */
export function selectedElements(context: SelectionContext): CanvasElementHandle[] {
  return [...context.selectedIds]
    .map(context.element)
    .filter((element): element is CanvasElementHandle => element != null);
}

/**
 * The single selected element, or null when nothing — or more than one thing —
 * is selected. Drives the affordances that only make sense one at a time.
 */
export function selectedElement(context: SelectionContext): CanvasElementHandle | null {
  if (context.selectedIds.size !== 1) return null;
  const [id] = context.selectedIds;
  return context.element(id);
}

/**
 * The selected element when it offers full rotate+resize controls.
 *
 * Transform affordances are declared per type on the extension: notes, text and
 * media rotate; sections and embedded documents declare resize without rotate,
 * so they land in `selectedResizeOnlyElement` instead. Everything else is
 * move-only and appears in neither.
 */
export function selectedTransformElement(
  context: SelectionContext,
): CanvasElementHandle | null {
  const element = selectedElement(context);
  if (!element?.canMove || !element.handles) return null;
  return element.transform.rotate ? element : null;
}

/** Types that resize but do not rotate get a lone resize handle. */
export function selectedResizeOnlyElement(
  context: SelectionContext,
): CanvasElementHandle | null {
  const element = selectedElement(context);
  if (!element?.canMove || !element.handles) return null;
  const { transform } = element;
  return transform.resize !== "none" && !transform.rotate ? element : null;
}

/**
 * The box around a multi-element selection, or null for one element or none.
 *
 * Multiple selected items behave as one uniformly-scaled group; a single item
 * keeps its type-specific controls, including rotation where supported.
 */
export function selectedGroupBounds(context: SelectionContext): Rect | null {
  const elements = selectedElements(context);
  if (elements.length < 2) return null;
  return unionBounds(
    elements.map((element) => element.bounds).filter((bounds) => bounds != null),
  );
}

/**
 * The group when every member can take part in a uniform scale, else null.
 *
 * Deliberately includes ordinary freehand strokes: their points transform
 * uniformly just as well as a shape's frame does. One locked or move-only
 * member disqualifies the whole group — a partial scale would break the
 * selection apart.
 */
export function selectedScalableSelection(
  context: SelectionContext,
): ScalableSelection | null {
  const bounds = selectedGroupBounds(context);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const elements = selectedElements(context);
  const blocked = elements.some(
    (element) =>
      !element.canMove || !element.transform.move || element.transform.resize === "none",
  );
  return blocked ? null : { bounds, elements };
}
