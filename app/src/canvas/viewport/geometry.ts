export type CanvasPoint = { x: number; y: number };

export type CanvasRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
};

const DEGREES_TO_RADIANS = Math.PI / 180;

export function normalizeRotation(rotation: number | undefined): number {
  const value = Number.isFinite(rotation) ? Number(rotation) : 0;
  return ((value % 360) + 360) % 360;
}

function radians(rotation: number | undefined) {
  return normalizeRotation(rotation) * DEGREES_TO_RADIANS;
}

export function rotateVector(
  point: CanvasPoint,
  rotation: number | undefined,
): CanvasPoint {
  const angle = radians(rotation);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}

export function shapeCenter(shape: CanvasRect): CanvasPoint {
  return { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
}

export function rotatedShapeCorners(shape: CanvasRect): CanvasPoint[] {
  const center = shapeCenter(shape);
  const halfWidth = shape.width / 2;
  const halfHeight = shape.height / 2;
  return [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight },
  ].map((corner) => {
    const rotated = rotateVector(corner, shape.rotation);
    return { x: center.x + rotated.x, y: center.y + rotated.y };
  });
}

export function rotatedShapeBounds(shape: CanvasRect): CanvasRect {
  const corners = rotatedShapeCorners(shape);
  const minX = Math.min(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));
  const maxX = Math.max(...corners.map((corner) => corner.x));
  const maxY = Math.max(...corners.map((corner) => corner.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pointInRotatedShape(point: CanvasPoint, shape: CanvasRect): boolean {
  const center = shapeCenter(shape);
  const local = rotateVector(
    { x: point.x - center.x, y: point.y - center.y },
    -normalizeRotation(shape.rotation),
  );
  return Math.abs(local.x) <= shape.width / 2 && Math.abs(local.y) <= shape.height / 2;
}

export function rotationFromPointer(center: CanvasPoint, point: CanvasPoint): number {
  return normalizeRotation(
    (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI + 90,
  );
}

export function snapRotation(rotation: number, increment = 15): number {
  return normalizeRotation(Math.round(rotation / increment) * increment);
}

export function pointOnRotatedShape(
  shape: CanvasRect,
  localPoint: CanvasPoint,
): CanvasPoint {
  const center = shapeCenter(shape);
  const localFromCenter = {
    x: localPoint.x - shape.width / 2,
    y: localPoint.y - shape.height / 2,
  };
  const rotated = rotateVector(localFromCenter, shape.rotation);
  return { x: center.x + rotated.x, y: center.y + rotated.y };
}

export function resizeRotatedShapeFromBottomRight(params: {
  fixedTopLeft: CanvasPoint;
  pointer: CanvasPoint;
  rotation: number;
  minSize: { width: number; height: number };
  aspect?: number;
}): Pick<CanvasRect, "x" | "y" | "width" | "height"> {
  const pointerInLocalSpace = rotateVector(
    {
      x: params.pointer.x - params.fixedTopLeft.x,
      y: params.pointer.y - params.fixedTopLeft.y,
    },
    -params.rotation,
  );

  let width = pointerInLocalSpace.x;
  let height = pointerInLocalSpace.y;
  if (params.aspect) {
    width = Math.max(width, height * params.aspect, params.minSize.width);
    height = width / params.aspect;
    if (height < params.minSize.height) {
      height = params.minSize.height;
      width = height * params.aspect;
    }
  } else {
    width = Math.max(params.minSize.width, width);
    height = Math.max(params.minSize.height, height);
  }

  const centerOffset = rotateVector({ x: width / 2, y: height / 2 }, params.rotation);
  const center = {
    x: params.fixedTopLeft.x + centerOffset.x,
    y: params.fixedTopLeft.y + centerOffset.y,
  };
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}
