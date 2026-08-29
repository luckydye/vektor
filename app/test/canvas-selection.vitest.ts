import { describe, expect, it } from "vitest";
import {
  type CanvasElementHandle,
  type SelectionContext,
  selectedElement,
  selectedElements,
  selectedGroupBounds,
  selectedResizeOnlyElement,
  selectedScalableSelection,
  selectedTransformElement,
} from "#canvas/runtime/selection.ts";

/** Transform affordances per type — the only extension data the model reads. */
const TRANSFORMS: Record<string, CanvasElementHandle["transform"]> = {
  note: { move: true, rotate: true, resize: "box" },
  section: { move: true, rotate: false, resize: "box" },
  embed: { move: true, rotate: false, resize: "none" },
  pinned: { move: false, rotate: false, resize: "box" },
  ink: { move: true, rotate: false, resize: "box" },
};

function shape(
  id: string,
  type: string,
  box = { x: 0, y: 0, w: 10, h: 10 },
): CanvasElementHandle {
  return {
    id,
    kind: "shape",
    type,
    locked: false,
    canMove: true,
    rotation: 0,
    bounds: { x: box.x, y: box.y, width: box.w, height: box.h },
    transform: TRANSFORMS[type],
    handles: true,
  };
}

function stroke(id: string, points: { x: number; y: number }[]): CanvasElementHandle {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    id,
    kind: "stroke",
    type: "ink",
    locked: false,
    canMove: true,
    rotation: 0,
    bounds:
      points.length === 0
        ? null
        : {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          },
    transform: TRANSFORMS.ink,
    handles: false,
  };
}

function context(
  elements: CanvasElementHandle[],
  selected: string[],
  overrides: Partial<CanvasElementHandle> = {},
): SelectionContext {
  const byId = new Map(elements.map((element) => [element.id, element]));
  return {
    selectedIds: new Set(selected),
    element: (id) => {
      const found = byId.get(id);
      return found ? { ...found, ...overrides } : null;
    },
  };
}

const note = shape("a", "note");
const section = shape("b", "section", { x: 40, y: 0, w: 20, h: 30 });
const embed = shape("c", "embed", { x: 0, y: 40, w: 10, h: 10 });
const pinned = shape("d", "pinned", { x: 0, y: 80, w: 10, h: 10 });
const line = stroke("s1", [
  { x: 0, y: 0 },
  { x: 100, y: 100 },
]);
const all = [note, section, embed, pinned, line];

describe("single-element selection", () => {
  it("resolves exactly one selected element", () => {
    expect(selectedElement(context(all, ["a"]))?.id).toBe("a");
    expect(selectedElement(context(all, []))).toBeNull();
    expect(selectedElement(context(all, ["a", "b"]))).toBeNull();
  });

  it("is null when a stroke is selected alongside the shape", () => {
    // The per-element affordances would otherwise appear over a mixed selection.
    expect(selectedElement(context(all, ["a", "s1"]))).toBeNull();
  });

  it("routes a rotatable type to transform and a resize-only type to resize", () => {
    const rotatable = context(all, ["a"]);
    expect(selectedTransformElement(rotatable)?.id).toBe("a");
    expect(selectedResizeOnlyElement(rotatable)).toBeNull();

    const resizeOnly = context(all, ["b"]);
    expect(selectedTransformElement(resizeOnly)).toBeNull();
    expect(selectedResizeOnlyElement(resizeOnly)?.id).toBe("b");
  });

  it("offers no handles for freehand ink, which has no box worth grabbing", () => {
    const ink = context(all, ["s1"]);
    expect(selectedTransformElement(ink)).toBeNull();
    expect(selectedResizeOnlyElement(ink)).toBeNull();
  });

  it("offers neither when the element cannot be moved", () => {
    const locked = context(all, ["a"], { canMove: false });
    expect(selectedTransformElement(locked)).toBeNull();
    expect(selectedResizeOnlyElement(locked)).toBeNull();
  });
});

describe("group selection", () => {
  it("drops ids that no longer resolve to an element", () => {
    const stale = context(all, ["a", "gone", "s1", "also-gone"]);
    expect(selectedElements(stale).map((element) => element.id)).toEqual(["a", "s1"]);
  });

  it("needs two elements before it is a group", () => {
    expect(selectedGroupBounds(context(all, ["a"]))).toBeNull();
    expect(selectedGroupBounds(context(all, ["a", "b"]))).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 30,
    });
  });

  it("still scales that ink as part of a group", () => {
    // Handles and group scaling are separate questions: ink transforms
    // uniformly with everything else even though it has no handles of its own.
    expect(selectedScalableSelection(context(all, ["a", "s1"]))?.bounds).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("unions shape boxes with stroke extents", () => {
    expect(selectedGroupBounds(context(all, ["a", "s1"]))).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it("scales a group of movable, resizable elements", () => {
    expect(selectedScalableSelection(context(all, ["a", "b"]))?.bounds).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 30,
    });
  });

  it("refuses the whole group when one member cannot resize", () => {
    // A partial scale would pull the selection apart, so one embed disqualifies
    // every other member too.
    expect(selectedScalableSelection(context(all, ["a", "c"]))).toBeNull();
  });

  it("refuses the group when one stroke is locked", () => {
    const lockedStroke = context(all, ["a", "s1"], { canMove: false });
    expect(selectedScalableSelection(lockedStroke)).toBeNull();
  });

  it("refuses the group when one member declares itself immovable", () => {
    expect(selectedScalableSelection(context(all, ["a", "d"]))).toBeNull();
  });

  it("refuses a group with no area on either axis", () => {
    // A degenerate box is a real bounds object with nothing to scale, and each
    // axis has to be rejected on its own — a vertical line has height but no
    // width, and scaling it would divide by zero.
    const collapsed = (points: { x: number; y: number }[][]) => {
      const strokes = points.map((p, i) => stroke(`s${i}`, p));
      return context(
        strokes,
        strokes.map((s) => s.id),
      );
    };

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
