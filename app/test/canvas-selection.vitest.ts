import { describe, expect, it } from "vitest";
import type { CanvasShape, CanvasStroke } from "#canvas/extensions/types.ts";
import {
  type SelectionContext,
  selectedCanvasItems,
  selectedGroupBounds,
  selectedResizeOnlyShape,
  selectedScalableSelection,
  selectedShape,
  selectedTransformShape,
} from "#canvas/selectionModel.ts";

/** Transform affordances per type — the only extension data the model reads. */
const TRANSFORMS: Record<string, { move: boolean; rotate: boolean; resize: string }> = {
  note: { move: true, rotate: true, resize: "box" },
  section: { move: true, rotate: false, resize: "box" },
  embed: { move: true, rotate: false, resize: "none" },
  pinned: { move: false, rotate: false, resize: "box" },
};

function shape(
  id: string,
  type: string,
  box = { x: 0, y: 0, w: 10, h: 10 },
): CanvasShape {
  return {
    id,
    type,
    frame: { x: box.x, y: box.y, width: box.w, height: box.h, rotation: 0 },
  } as CanvasShape;
}

function stroke(id: string, points: { x: number; y: number }[]): CanvasStroke {
  return { id, points } as CanvasStroke;
}

function context(overrides: Partial<SelectionContext> = {}): SelectionContext {
  const shapes = overrides.shapesById ?? new Map();
  const strokes = overrides.strokesById ?? new Map();
  return {
    shapesById: shapes,
    strokesById: strokes,
    selectedShapeIds: new Set(),
    selectedStrokeIds: new Set(),
    extensions: {
      get: (type: string) => ({ behavior: { transform: TRANSFORMS[type] } }),
    } as unknown as SelectionContext["extensions"],
    canMoveShape: () => true,
    canMoveStroke: () => true,
    shapeAabb: (s) => ({
      x: s.frame.x,
      y: s.frame.y,
      width: s.frame.width,
      height: s.frame.height,
    }),
    strokeBounds: (s) => {
      const xs = s.points.map((p) => p.x);
      const ys = s.points.map((p) => p.y);
      if (xs.length === 0) return null;
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    },
    ...overrides,
  };
}

const note = shape("a", "note");
const section = shape("b", "section", { x: 40, y: 0, w: 20, h: 30 });
const embed = shape("c", "embed", { x: 0, y: 40, w: 10, h: 10 });
const pinned = shape("d", "pinned", { x: 0, y: 80, w: 10, h: 10 });
const shapesById = new Map([note, section, embed, pinned].map((s) => [s.id, s]));

describe("single-shape selection", () => {
  it("resolves exactly one selected shape", () => {
    const one = context({ shapesById, selectedShapeIds: new Set(["a"]) });
    expect(selectedShape(one)?.id).toBe("a");
    expect(selectedShape(context({ shapesById }))).toBeNull();
    expect(
      selectedShape(context({ shapesById, selectedShapeIds: new Set(["a", "b"]) })),
    ).toBeNull();
  });

  it("is null when a stroke is selected alongside the shape", () => {
    // The per-shape affordances would otherwise appear over a mixed selection.
    const mixed = context({
      shapesById,
      selectedShapeIds: new Set(["a"]),
      selectedStrokeIds: new Set(["s1"]),
    });
    expect(selectedShape(mixed)).toBeNull();
  });

  it("routes a rotatable type to transform and a resize-only type to resize", () => {
    const rotatable = context({ shapesById, selectedShapeIds: new Set(["a"]) });
    expect(selectedTransformShape(rotatable)?.id).toBe("a");
    expect(selectedResizeOnlyShape(rotatable)).toBeNull();

    const resizeOnly = context({ shapesById, selectedShapeIds: new Set(["b"]) });
    expect(selectedTransformShape(resizeOnly)).toBeNull();
    expect(selectedResizeOnlyShape(resizeOnly)?.id).toBe("b");
  });

  it("offers neither when the shape cannot be moved", () => {
    const locked = context({
      shapesById,
      selectedShapeIds: new Set(["a"]),
      canMoveShape: () => false,
    });
    expect(selectedTransformShape(locked)).toBeNull();
    expect(selectedResizeOnlyShape(locked)).toBeNull();
  });
});

describe("group selection", () => {
  const strokesById = new Map([
    [
      "s1",
      stroke("s1", [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ]),
    ],
  ]);

  it("drops ids that no longer resolve to an element", () => {
    const stale = context({
      shapesById,
      strokesById,
      selectedShapeIds: new Set(["a", "gone"]),
      selectedStrokeIds: new Set(["s1", "also-gone"]),
    });
    const items = selectedCanvasItems(stale);
    expect(items.shapes.map((s) => s.id)).toEqual(["a"]);
    expect(items.strokes.map((s) => s.id)).toEqual(["s1"]);
  });

  it("needs two elements before it is a group", () => {
    expect(
      selectedGroupBounds(context({ shapesById, selectedShapeIds: new Set(["a"]) })),
    ).toBeNull();
    expect(
      selectedGroupBounds(context({ shapesById, selectedShapeIds: new Set(["a", "b"]) })),
    ).toEqual({ x: 0, y: 0, width: 60, height: 30 });
  });

  it("unions shape boxes with stroke extents", () => {
    const mixed = context({
      shapesById,
      strokesById,
      selectedShapeIds: new Set(["a"]),
      selectedStrokeIds: new Set(["s1"]),
    });
    expect(selectedGroupBounds(mixed)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("scales a group of movable, resizable elements", () => {
    const scalable = context({
      shapesById,
      strokesById,
      selectedShapeIds: new Set(["a", "b"]),
    });
    expect(selectedScalableSelection(scalable)?.bounds).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 30,
    });
  });

  it("refuses the whole group when one member cannot resize", () => {
    // A partial scale would pull the selection apart, so one embed disqualifies
    // every other member too.
    const withEmbed = context({
      shapesById,
      selectedShapeIds: new Set(["a", "c"]),
    });
    expect(selectedScalableSelection(withEmbed)).toBeNull();
  });

  it("refuses the group when one stroke is locked", () => {
    const lockedStroke = context({
      shapesById,
      strokesById,
      selectedShapeIds: new Set(["a"]),
      selectedStrokeIds: new Set(["s1"]),
      canMoveStroke: () => false,
    });
    expect(selectedScalableSelection(lockedStroke)).toBeNull();
  });

  it("refuses the group when one member declares itself immovable", () => {
    const withPinned = context({
      shapesById,
      selectedShapeIds: new Set(["a", "d"]),
    });
    expect(selectedScalableSelection(withPinned)).toBeNull();
  });

  it("refuses a group with no area on either axis", () => {
    // A degenerate box is a real bounds object with nothing to scale, and each
    // axis has to be rejected on its own — a vertical line has height but no
    // width, and scaling it would divide by zero.
    const collapsed = (points: { x: number; y: number }[][]) =>
      context({
        strokesById: new Map(
          points.map((p, i) => [`s${i}`, stroke(`s${i}`, p)] as const),
        ),
        selectedStrokeIds: new Set(points.map((_, i) => `s${i}`)),
      });

    expect(
      selectedScalableSelection(collapsed([[{ x: 5, y: 5 }], [{ x: 5, y: 5 }]])),
    ).toBeNull();
    // Vertical: zero width, real height.
    expect(
      selectedScalableSelection(collapsed([[{ x: 5, y: 0 }], [{ x: 5, y: 40 }]])),
    ).toBeNull();
    // Horizontal: real width, zero height.
    expect(
      selectedScalableSelection(collapsed([[{ x: 0, y: 5 }], [{ x: 40, y: 5 }]])),
    ).toBeNull();
  });
});
