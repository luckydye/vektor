import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  CANVAS_SHAPES_KEY,
  CANVAS_STROKES_KEY,
  seedCanvasDoc,
} from "#utils/canvasYjs.ts";

describe("canvas shape rotation persistence", () => {
  it("defaults older snapshots to an unrotated shape", () => {
    const doc = new Y.Doc();
    seedCanvasDoc(doc, {
      shapes: [
        {
          id: "legacy-shape",
          type: "note",
          x: 10,
          y: 20,
          width: 200,
          height: 120,
          text: "Note",
          color: "#fef3c7",
        },
      ],
    });

    expect(
      doc.getMap<Y.Map<unknown>>(CANVAS_SHAPES_KEY).get("legacy-shape")?.get("rotation"),
    ).toBe(0);
  });

  it("preserves a persisted rotation", () => {
    const doc = new Y.Doc();
    seedCanvasDoc(doc, {
      shapes: [
        {
          id: "rotated-shape",
          type: "note",
          x: 10,
          y: 20,
          width: 200,
          height: 120,
          rotation: 135,
          text: "Note",
          color: "#fef3c7",
        },
      ],
    });

    expect(
      doc.getMap<Y.Map<unknown>>(CANVAS_SHAPES_KEY).get("rotated-shape")?.get("rotation"),
    ).toBe(135);
  });

  it("keeps stamped shapes identifiable after persistence", () => {
    const doc = new Y.Doc();
    seedCanvasDoc(doc, {
      strokes: [
        {
          id: "shape-stroke",
          kind: "shape",
          rotation: 45,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
          style: {},
        },
      ],
    });

    expect(
      doc.getMap<Y.Map<unknown>>(CANVAS_STROKES_KEY).get("shape-stroke")?.get("kind"),
    ).toBe("shape");
    expect(
      doc.getMap<Y.Map<unknown>>(CANVAS_STROKES_KEY).get("shape-stroke")?.get("rotation"),
    ).toBe(45);
  });
});
