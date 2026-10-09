import { describe, expect, it } from "vitest";
import {
  pointInRotatedShape,
  resizeRotatedShape,
  rotatedShapeBounds,
  rotatedShapeCorners,
  rotationFromPointer,
  snapRotation,
} from "#canvas/runtime/geometry.ts";

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
    const resized = resizeRotatedShape({
      initial: shape,
      handle: { x: 1, y: 1 },
      pointer: { x: 120, y: 300 },
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

  it("resizes from the start edge, keeping the opposite edge in place", () => {
    const box = { x: 0, y: 0, width: 100, height: 50, rotation: 0 };
    const resized = resizeRotatedShape({
      initial: box,
      handle: { x: -1, y: 0 },
      pointer: { x: -20, y: 999 },
      minSize: { width: 10, height: 10 },
    });

    expect(resized.x).toBeCloseTo(-20);
    expect(resized.y).toBeCloseTo(0);
    expect(resized.width).toBeCloseTo(120);
    expect(resized.height).toBeCloseTo(50);
  });
});
