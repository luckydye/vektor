import type { CanvasExtensionManager } from "#canvas/extensions/registry.ts";
import type { CanvasShape, CanvasStroke } from "#canvas/extensions/types.ts";
import type { Rect } from "#canvas/viewport/bounds.ts";
import { unionBounds } from "#canvas/viewport/bounds.ts";

/**
 * What is selected, and what the selection can be asked to do.
 *
 * Touches neither the DOM nor a framework — it is a question about two id sets
 * and two element maps, so it can be answered the same way from a component,
 * the custom-element host, or a test.
 */

export interface SelectionContext {
  shapesById: ReadonlyMap<string, CanvasShape>;
  strokesById: ReadonlyMap<string, CanvasStroke>;
  selectedShapeIds: ReadonlySet<string>;
  selectedStrokeIds: ReadonlySet<string>;
  extensions: CanvasExtensionManager;
  /**
   * Permission and lock checks. Passed in rather than derived here: they depend
   * on the current user and the space role, which the selection has no business
   * knowing.
   */
  canMoveShape: (shape: CanvasShape) => boolean;
  canMoveStroke: (stroke: CanvasStroke) => boolean;
  /** A shape's axis-aligned world box, rotation included. */
  shapeAabb: (shape: CanvasShape) => Rect;
  strokeBounds: (stroke: Pick<CanvasStroke, "points">) => Rect | null;
}

export interface SelectedCanvasItems {
  shapes: CanvasShape[];
  strokes: CanvasStroke[];
}

export interface ScalableSelection extends SelectedCanvasItems {
  bounds: Rect;
}

/**
 * The single selected shape, or null when nothing — or more than one thing — is
 * selected. Drives the affordances that only make sense for one shape at a time.
 */
export function selectedShape(context: SelectionContext): CanvasShape | null {
  if (context.selectedShapeIds.size !== 1 || context.selectedStrokeIds.size > 0) {
    return null;
  }
  const [id] = context.selectedShapeIds;
  return context.shapesById.get(id) ?? null;
}

/**
 * The selected shape when it offers full rotate+resize controls.
 *
 * Transform affordances are declared per type on the extension: notes, text and
 * media rotate; sections and embedded documents declare resize without rotate,
 * so they land in `selectedResizeOnlyShape` instead. Everything else is
 * move-only and appears in neither.
 */
export function selectedTransformShape(context: SelectionContext): CanvasShape | null {
  const shape = selectedShape(context);
  if (!shape || !context.canMoveShape(shape)) return null;
  return context.extensions.get(shape.type).behavior.transform.rotate ? shape : null;
}

/** Types that resize but do not rotate get a lone resize handle. */
export function selectedResizeOnlyShape(context: SelectionContext): CanvasShape | null {
  const shape = selectedShape(context);
  if (!shape || !context.canMoveShape(shape)) return null;
  const transform = context.extensions.get(shape.type).behavior.transform;
  return transform && transform.resize !== "none" && !transform.rotate ? shape : null;
}

/** The selected ids resolved to elements, dropping any that no longer exist. */
export function selectedCanvasItems(context: SelectionContext): SelectedCanvasItems {
  return {
    shapes: [...context.selectedShapeIds]
      .map((id) => context.shapesById.get(id))
      .filter((shape): shape is CanvasShape => shape != null),
    strokes: [...context.selectedStrokeIds]
      .map((id) => context.strokesById.get(id))
      .filter((stroke): stroke is CanvasStroke => stroke != null),
  };
}

export function boundsForCanvasItems(
  items: SelectedCanvasItems,
  context: Pick<SelectionContext, "shapeAabb" | "strokeBounds">,
): Rect | null {
  return unionBounds([
    ...items.shapes.map(context.shapeAabb),
    ...items.strokes
      .map(context.strokeBounds)
      .filter((bounds): bounds is Rect => bounds != null),
  ]);
}

/**
 * The box around a multi-element selection, or null for one element or none.
 *
 * Multiple selected items behave as one uniformly-scaled group; a single item
 * keeps its type-specific controls, including rotation where supported.
 */
export function selectedGroupBounds(context: SelectionContext): Rect | null {
  const items = selectedCanvasItems(context);
  if (items.shapes.length + items.strokes.length < 2) return null;
  return boundsForCanvasItems(items, context);
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
  const items = selectedCanvasItems(context);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
  const blocked =
    items.shapes.some((shape) => {
      const transform = context.extensions.get(shape.type).behavior.transform;
      return (
        !context.canMoveShape(shape) || !transform.move || transform.resize === "none"
      );
    }) || items.strokes.some((stroke) => !context.canMoveStroke(stroke));
  return blocked ? null : { bounds, ...items };
}
