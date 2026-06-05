// An artboard: a canvas positioned in world space.
// In the photo editor there is typically one artboard at (0, 0) with the image dimensions.
// Multiple artboards can coexist in world space for layouts with several canvases.
export interface Artboard {
  worldX: number;
  worldY: number;
  width: number;
  height: number;
}

// A rect placed on an artboard with an optional 2D affine transform matrix.
// Matrix format: CSS transform matrix notation [a, b, c, d, e, f]
//   | a  c  e |
//   | b  d  f |
//   | 0  0  1 |
// Transforms are applied in artboard-local space before the artboard's own world transform.
export interface PlacedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  matrix?: [number, number, number, number, number, number];
}

// A rendered image tile positioned in artboard-local coordinates.
// The image pixel dimensions may differ from width/height due to device pixel ratio scaling.
export interface RenderedTile {
  image: ImageData;
  // Artboard-local position of the top-left corner of the region this tile covers
  x: number;
  y: number;
  // Artboard-local extent (world-space size of the region)
  width: number;
  height: number;
}

// Camera: defines what portion of world space is visible in the viewport.
export interface ViewportCamera {
  // World-space point shown at the center of the screen
  centerX: number;
  centerY: number;
  // Zoom multiplier: 1.0 = fit reference fills the screen
  zoom: number;
}

// The rect used to compute the fit scale (what "zoom = 1" means).
// Usually the active crop rect, or the full artboard when in crop-edit mode.
export interface FitReference {
  x: number;
  y: number;
  width: number;
  height: number;
}

// A clip rect in artboard-local coordinates. Drawing is clipped to this region.
// rotation is in radians.
export interface ArtboardClip {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}
