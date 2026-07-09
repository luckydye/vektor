import { describe, expect, it } from "bun:test";
import {
  pointInRotatedShape,
  resizeRotatedShapeFromBottomRight,
  rotatedShapeBounds,
  rotatedShapeCorners,
  rotationFromPointer,
  snapRotation,
} from "#canvas/geometry.ts";

describe("canvas transform geometry", () => {
  const shape = { x: 100, y: 200, width: 80, height: 40, rotation: 90 };

  it("rotates corners and expands the axis-aligned bounds", () => {
    expect(rotatedShapeCorners(shape)[0]).toEqual({ x: 160, y: 180 });
    expect(rotatedShapeBounds(shape)).toEqual({ x: 120, y: 180, width: 40, height: 80 });
  });

  it("hit-tests in the shape's unrotated local space", () => {
    expect(pointInRotatedShape({ x: 160, y: 190 }, shape)).toBe(true);
    expect(pointInRotatedShape({ x: 110, y: 200 }, shape)).toBe(false);
  });

  it("derives and snaps a rotation from the centre point", () => {
    const center = { x: 140, y: 220 };
    expect(rotationFromPointer(center, { x: 140, y: 180 })).toBe(0);
    expect(rotationFromPointer(center, { x: 180, y: 220 })).toBe(90);
    expect(snapRotation(22)).toBe(15);
    expect(snapRotation(353)).toBe(0);
  });

  it("resizes a rotated shape while keeping its opposite corner fixed", () => {
    const fixedTopLeft = rotatedShapeCorners(shape)[0];
    const resized = resizeRotatedShapeFromBottomRight({
      fixedTopLeft,
      pointer: { x: 120, y: 300 },
      rotation: 90,
      minSize: { width: 20, height: 20 },
    });

    expect(resized.x).toBeCloseTo(80);
    expect(resized.y).toBeCloseTo(220);
    expect(resized.width).toBeCloseTo(120);
    expect(resized.height).toBeCloseTo(40);
    const topLeft = rotatedShapeCorners({ ...resized, rotation: 90 })[0];
    expect(topLeft.x).toBeCloseTo(fixedTopLeft.x);
    expect(topLeft.y).toBeCloseTo(fixedTopLeft.y);
  });
});
