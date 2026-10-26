/**
 * Draws a stored canvas snapshot on the server, in the light theme: the same
 * outlines, routes and text layout the WebGL painters use, with media and
 * embeds drawn as labelled cards. What an agent sees when it looks.
 */

import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import {
  contrastText,
  dashPattern,
  GEO_PARAGRAPH_GAP,
  geoLabelBox,
  geoOutline,
  geoStyle,
  insetPolyline,
  lineHead,
  lineStyle,
  nodesToWorld,
  lineLabelCenter,
  resolveLine,
  type ShapeLike,
} from "#canvas/render/shapeGeometry.ts";
import type { TextLayout } from "#canvas/render/textLayout.ts";
import { type FillPath, flattenPath, strokePath } from "#canvas/render/vector.ts";
import { parseColor, type Rgba } from "#canvas/render/webgl.ts";
import { pointOnRotatedShape } from "#canvas/runtime/geometry.ts";
import {
  createRaster,
  drawRasterText,
  fillWorldPath,
  type Raster,
  type RasterView,
} from "#canvas/raster/rasterizer.ts";
import { layoutLine, layoutMarkdown, serverFonts } from "#canvas/raster/text.ts";

export const THEME = {
  background: "#fafaf9",
  text: "#111827",
  muted: "#6b7280",
  border: "rgba(15, 23, 42, 0.14)",
  frame: "#9ca3af",
};

/** A stored shape, normalized enough to draw: every frame has its size. */
export interface SceneShape extends ShapeLike {
  style: { color: string };
  z: number;
}

export interface SceneStroke {
  points: { x: number; y: number; width: number }[];
  color: string;
  width: number;
}

const TEXT_FONT_SIZE = 15;
const TEXT_INSET = 5;
const NOTE_INSET = 13;

/** A text element's box, which it sizes from its content rather than storing. */
export function measureTextShape(
  data: Record<string, unknown>,
  faces: ReadonlyMap<FontFace, Font>,
) {
  const text = typeof data.text === "string" ? data.text : "";
  const size = TEXT_FONT_SIZE * (Number(data.fontScale) || 1);
  const layout = layoutMarkdown(text, { size, color: THEME.text }, Number.POSITIVE_INFINITY, faces);
  return {
    width: Math.max(32, Math.ceil(layout.width + TEXT_INSET * 2)),
    height: Math.max(40, Math.ceil(layout.height + TEXT_INSET * 2)),
  };
}

function rgba(color: string): Rgba {
  return parseColor(color);
}

function placement(shape: ShapeLike, view: RasterView, local: { x: number; y: number }) {
  const world = pointOnRotatedShape(shape.frame, local);
  return {
    origin: { x: world.x * view.scale + view.dx, y: world.y * view.scale + view.dy },
    scale: view.scale,
    rotation: (shape.frame.rotation * Math.PI) / 180,
  };
}

function rectPath(shape: ShapeLike, radius = 0): FillPath {
  const outline = geoOutline("rect", shape.frame, { radius });
  return { rings: [flattenPath(nodesToWorld(shape.frame, outline.nodes), true, 0.5)], rule: "nonzero" };
}

function strokeRect(raster: Raster, view: RasterView, shape: ShapeLike, color: string, width: number, radius = 0) {
  const outline = geoOutline("rect", shape.frame, { radius });
  const points = flattenPath(nodesToWorld(shape.frame, outline.nodes), true, 0.5);
  fillWorldPath(
    raster,
    view,
    strokePath([{ points, closed: true }], { width, join: "miter", pattern: null, tolerance: 0.5 }),
    rgba(color),
  );
}

function drawLabel(raster: Raster, layout: TextLayout, faces: ReadonlyMap<FontFace, Font>, at: ReturnType<typeof placement>) {
  drawRasterText(raster, layout, faces, at);
}

function paintGeo(raster: Raster, view: RasterView, shape: SceneShape, faces: ReadonlyMap<FontFace, Font>) {
  const style = geoStyle(shape.data);
  const outline = geoOutline(style.kind, shape.frame, shape.data);
  const tolerance = 0.3 / view.scale;
  const body = flattenPath(nodesToWorld(shape.frame, outline.nodes), outline.closed, tolerance);
  if (outline.closed && shape.style.color !== "transparent") {
    fillWorldPath(raster, view, { rings: [body], rule: "nonzero" }, rgba(shape.style.color));
  }
  if (style.strokeWidth > 0 && style.stroke !== "transparent") {
    const details = outline.details.map((detail) => ({
      points: flattenPath(nodesToWorld(shape.frame, detail.nodes), detail.closed, tolerance),
      closed: detail.closed,
    }));
    fillWorldPath(
      raster,
      view,
      strokePath([{ points: body, closed: outline.closed }, ...details], {
        width: style.strokeWidth,
        join: style.kind === "ellipse" ? "round" : "miter",
        pattern: dashPattern(style.dash, style.strokeWidth),
        tolerance,
      }),
      rgba(style.stroke),
    );
  }
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  if (!text.trim()) return;
  const box = geoLabelBox(style, shape.frame);
  const color = style.textColor || contrastText(shape.style.color, THEME.text);
  const layout = layoutMarkdown(
    text,
    { size: style.fontSize, color, align: style.align, paragraphGap: GEO_PARAGRAPH_GAP },
    box.width,
    faces,
  );
  const free = box.height - layout.height;
  const y = style.valign === "top" ? box.y : style.valign === "bottom" ? box.y + free : box.y + free / 2;
  drawLabel(raster, layout, faces, placement(shape, view, { x: box.x, y }));
}

function paintLine(
  raster: Raster,
  view: RasterView,
  shape: SceneShape,
  lookup: (id: string) => ShapeLike | undefined,
  faces: ReadonlyMap<FontFace, Font>,
) {
  const style = lineStyle(shape.data);
  const tolerance = 0.3 / view.scale;
  const { points, start, end } = resolveLine(shape.data, lookup, tolerance);
  const color = rgba(style.color);
  const heads = [lineHead(style.start, start, style.width), lineHead(style.end, end, style.width)];
  const stroke = (lines: { points: { x: number; y: number }[]; closed: boolean }[], pattern: [number, number] | null) =>
    fillWorldPath(raster, view, strokePath(lines, { width: style.width, join: "round", pattern, tolerance }), color);
  stroke([{ points: insetPolyline(points, heads[0].inset, heads[1].inset), closed: false }], dashPattern(style.dash, style.width));
  stroke(heads.flatMap((head) => (head.stroke ? [{ points: head.stroke, closed: false }] : [])), null);
  for (const head of heads) {
    if (head.fill) fillWorldPath(raster, view, { rings: [head.fill], rule: "nonzero" }, color);
  }
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  if (!text) return;
  const layout = layoutLine(text, { face: "regular", size: style.fontSize, color: THEME.text }, faces, 240);
  const mid = lineLabelCenter(points, style.labelAt, layout);
  const pad = 4;
  const box: ShapeLike = {
    id: "",
    type: "",
    data: {},
    frame: {
      x: mid.x - layout.width / 2 - pad,
      y: mid.y - layout.height / 2 - pad / 2,
      width: layout.width + pad * 2,
      height: layout.height + pad,
      rotation: 0,
    },
  };
  fillWorldPath(raster, view, rectPath(box, 4), rgba(THEME.background));
  drawLabel(raster, layout, faces, {
    origin: {
      x: (mid.x - layout.width / 2) * view.scale + view.dx,
      y: (mid.y - layout.height / 2) * view.scale + view.dy,
    },
    scale: view.scale,
    rotation: 0,
  });
}

function paintSection(raster: Raster, view: RasterView, shape: SceneShape) {
  if (typeof shape.data.background === "string") {
    fillWorldPath(raster, view, rectPath(shape), rgba(shape.data.background));
  }
  if (shape.style.color === "transparent") return;
  const color = rgba(shape.style.color);
  fillWorldPath(raster, view, rectPath(shape), [color[0], color[1], color[2], color[3] * 0.06]);
}

/** A frame's border and title, drawn above everything as on the canvas. */
function paintSectionChrome(raster: Raster, view: RasterView, shape: SceneShape, faces: ReadonlyMap<FontFace, Font>) {
  const transparent = shape.style.color === "transparent";
  strokeRect(raster, view, shape, transparent ? THEME.frame : shape.style.color, 1 / view.scale);
  const title = typeof shape.data.text === "string" && shape.data.text ? shape.data.text : "Section";
  // The title sits above the frame at a fixed screen size, as on the canvas.
  const layout = layoutLine(title, { face: "regular", size: 12, color: THEME.muted }, faces, Math.max(1, shape.frame.width * view.scale));
  drawLabel(raster, layout, faces, {
    origin: {
      x: shape.frame.x * view.scale + view.dx,
      y: shape.frame.y * view.scale + view.dy - 20,
    },
    scale: 1,
    rotation: 0,
  });
}

function paintNote(raster: Raster, view: RasterView, shape: SceneShape, faces: ReadonlyMap<FontFace, Font>) {
  fillWorldPath(raster, view, rectPath(shape, 8), rgba(shape.style.color));
  strokeRect(raster, view, shape, THEME.border, 1, 8);
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  const size = typeof shape.data.fontSize === "number" ? shape.data.fontSize : 15;
  const layout = layoutMarkdown(text, { size, color: "#111827" }, shape.frame.width - NOTE_INSET * 2, faces);
  drawLabel(raster, layout, faces, placement(shape, view, { x: NOTE_INSET, y: NOTE_INSET }));
}

function paintText(raster: Raster, view: RasterView, shape: SceneShape, faces: ReadonlyMap<FontFace, Font>) {
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  const size = TEXT_FONT_SIZE * (Number(shape.data.fontScale) || 1);
  const layout = layoutMarkdown(text, { size, color: THEME.text }, Number.POSITIVE_INFINITY, faces);
  drawLabel(raster, layout, faces, placement(shape, view, { x: TEXT_INSET, y: TEXT_INSET }));
}

/** Media and embeds: a card naming what would be there. */
function paintCard(raster: Raster, view: RasterView, shape: SceneShape, faces: ReadonlyMap<FontFace, Font>) {
  fillWorldPath(raster, view, rectPath(shape, 8), rgba("#e5e7eb"));
  strokeRect(raster, view, shape, THEME.border, 1, 8);
  const name =
    [shape.data.title, shape.data.name, shape.data.alt, shape.data.url, shape.data.src].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ?? "";
  const label = `${shape.type}${name ? `: ${name}` : ""}`;
  const layout = layoutMarkdown(label.replace(/[*_`[\]]/g, ""), { size: 14, color: THEME.muted, align: "center" }, shape.frame.width - 24, faces);
  drawLabel(raster, layout, faces, placement(shape, view, { x: 12, y: (shape.frame.height - layout.height) / 2 }));
}

function paintStroke(raster: Raster, view: RasterView, stroke: SceneStroke) {
  if (stroke.points.length === 0) return;
  const width = stroke.points.reduce((sum, point) => sum + point.width, 0) / stroke.points.length || stroke.width;
  fillWorldPath(
    raster,
    view,
    strokePath([{ points: stroke.points, closed: false }], { width, join: "round", pattern: null, tolerance: 0.3 / view.scale }),
    rgba(stroke.color),
  );
}

/** The type layer, as the canvas stacks them: sections behind everything. */
export function typeLayer(type: string) {
  return type === "section" ? -1 : 0;
}

export async function renderScene(options: {
  shapes: readonly SceneShape[];
  strokes: readonly SceneStroke[];
  region: { x: number; y: number; width: number; height: number };
  scale: number;
  /** Small id tags on every element, to tell which is which. */
  ids?: boolean;
}): Promise<Raster> {
  const faces = await serverFonts();
  const { region, scale } = options;
  const width = Math.max(1, Math.round(region.width * scale));
  const height = Math.max(1, Math.round(region.height * scale));
  const raster = createRaster(width, height, rgba(THEME.background));
  const view: RasterView = { scale, dx: -region.x * scale, dy: -region.y * scale };
  const byId = new Map(options.shapes.map((shape) => [shape.id, shape]));
  const lookup = (id: string) => byId.get(id);
  const ordered = [...options.shapes].sort(
    (a, b) => typeLayer(a.type) - typeLayer(b.type) || a.z - b.z || a.id.localeCompare(b.id),
  );
  for (const shape of ordered) {
    if (shape.type === "geo") paintGeo(raster, view, shape, faces);
    else if (shape.type === "line") paintLine(raster, view, shape, lookup, faces);
    else if (shape.type === "section") paintSection(raster, view, shape);
    else if (shape.type === "note") paintNote(raster, view, shape, faces);
    else if (shape.type === "text") paintText(raster, view, shape, faces);
    else paintCard(raster, view, shape, faces);
  }
  for (const stroke of options.strokes) paintStroke(raster, view, stroke);
  for (const shape of ordered) {
    if (shape.type === "section") paintSectionChrome(raster, view, shape, faces);
  }
  if (options.ids) {
    for (const shape of ordered) {
      if (shape.type === "line") continue;
      const tag = layoutLine(shape.id, { face: "mono", size: 11, color: "#ffffff" }, faces);
      const x = shape.frame.x * scale + view.dx;
      const y = shape.frame.y * scale + view.dy;
      const box: ShapeLike = {
        id: "",
        type: "",
        data: {},
        frame: { x: x - 2, y: y - 2, width: tag.width + 6, height: tag.height + 2, rotation: 0 },
      };
      fillWorldPath(raster, { scale: 1, dx: 0, dy: 0 }, rectPath(box, 3), [0.15, 0.39, 0.92, 0.85]);
      drawRasterText(raster, tag, faces, { origin: { x: x + 1, y: y - 1 }, scale: 1, rotation: 0 });
    }
  }
  return raster;
}
