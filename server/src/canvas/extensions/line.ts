import { fillPath } from "#canvas/render/paths.ts";
import { drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import {
  dashPattern,
  distanceToPolyline,
  insetPolyline,
  type LineEnd,
  type LineGeometry,
  lineEnd,
  lineHead,
  lineStyle,
  lineVia,
  lineLabelCenter,
  resolveLine,
} from "#canvas/render/shapeGeometry.ts";
import { drawTextField, drawTextLayout, lineLayout, middlePlacement } from "#canvas/render/text.ts";
import type { TextStyle } from "#canvas/render/textLayout.ts";
import { polygonBounds, strokePath } from "#canvas/render/vector.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import type {
  CanvasExtensionHost,
  CanvasHitTestHelpers,
  CanvasPaintHelpers,
  CanvasPoint,
  CanvasPointerGestureHandlers,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement, CanvasTool } from "#canvas/runtime/extensionApi.ts";
import { iconMarkup } from "#components/Icon.tsx";
import { STROKE_COLORS } from "#canvas/extensions/geo.ts";

/** Screen pixels around the path, and around each end, that still hit it. */
const HIT_SLOP = 6;
const END_SLOP = 9;
const LABEL_WIDTH = 240;

function geometry(shape: CanvasShape): LineGeometry {
  const resolved = shape.derived?.geometry as LineGeometry | undefined;
  if (!resolved) throw new Error(`Line ${shape.id} was not resolved`);
  return resolved;
}

function labelStyle(shape: CanvasShape, color: string): TextStyle {
  return { face: "regular", size: lineStyle(shape.data).fontSize, color };
}

function labelText(shape: CanvasShape) {
  return typeof shape.data.text === "string" ? shape.data.text : "";
}

function paintLine(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const style = lineStyle(shape.data);
  const color = parseColor(style.color);
  const { points, start, end } = geometry(shape);
  const tolerance = 0.25 / helpers.scale;
  const heads = [lineHead(style.start, start, style.width), lineHead(style.end, end, style.width)];
  const stroke = (lines: { points: CanvasPoint[]; closed: boolean }[], pattern: [number, number] | null) =>
    fillPath(gpu, strokePath(lines, { width: style.width, join: "round", pattern, tolerance }), color);
  stroke(
    [{ points: insetPolyline(points, heads[0].inset, heads[1].inset), closed: false }],
    dashPattern(style.dash, style.width),
  );
  // Heads stay solid whatever the line's dash.
  stroke(
    heads.flatMap((head) => (head.stroke ? [{ points: head.stroke, closed: false }] : [])),
    null,
  );
  for (const head of heads) {
    if (head.fill) fillPath(gpu, { rings: [head.fill], rule: "nonzero" }, color);
  }

  const text = labelText(shape);
  const edit = helpers.textEdit(shape.id);
  if (!text && !edit) return;
  const textColor = helpers.color("--canvas-text");
  const measured = lineLayout(text || " ", labelStyle(shape, textColor), helpers.invalidate, LABEL_WIDTH);
  const mid = lineLabelCenter(points, lineStyle(shape.data).labelAt, measured ?? { width: 0, height: 0 });
  const at = { x: mid.x * helpers.scale + helpers.dx, y: mid.y * helpers.scale + helpers.dy };
  if (edit) {
    const style = { ...labelStyle(shape, textColor), size: lineStyle(shape.data).fontSize * helpers.scale };
    const width = lineLayout(edit.value || " ", style, helpers.invalidate)?.width ?? 0;
    drawTextField(gpu, edit, style, { x: at.x - width / 2, y: at.y }, helpers.invalidate);
    return;
  }
  const layout = lineLayout(text, labelStyle(shape, textColor), helpers.invalidate, LABEL_WIDTH);
  if (!layout) return;
  const pad = 4 * helpers.scale;
  const width = layout.width * helpers.scale;
  const height = layout.height * helpers.scale;
  drawRoundedRect(gpu, rectQuad(at.x - width / 2 - pad, at.y - height / 2 - pad / 2, width + pad * 2, height + pad), {
    radius: 4 * helpers.scale,
    fill: parseColor(helpers.color("--canvas-bg")),
  });
  drawTextLayout(gpu, layout, middlePlacement(layout, { x: at.x - width / 2, y: at.y }, helpers.scale));
}

function hitTestLine(shape: CanvasShape, world: CanvasPoint, helpers: CanvasHitTestHelpers) {
  const { points } = geometry(shape);
  const screen = helpers.worldToScreen(world);
  const onScreen = points.map(helpers.worldToScreen);
  const near = (point: CanvasPoint) => Math.hypot(point.x - screen.x, point.y - screen.y) <= END_SLOP;
  if (near(onScreen[0])) return "start";
  if (near(onScreen[onScreen.length - 1])) return "end";
  const scale = helpers.worldToScreen({ x: 1, y: 0 }).x - helpers.worldToScreen({ x: 0, y: 0 }).x;
  const slop = HIT_SLOP + (lineStyle(shape.data).width * scale) / 2;
  if (distanceToPolyline(screen, onScreen) <= slop) return "body";
  const label = lineLayout(labelText(shape), labelStyle(shape, "#000"), () => {}, LABEL_WIDTH);
  if (label && labelText(shape)) {
    const mid = helpers.worldToScreen(lineLabelCenter(points, lineStyle(shape.data).labelAt, label));
    const half = { x: (label.width / 2 + 4) * scale, y: (label.height / 2 + 2) * scale };
    if (Math.abs(mid.x - screen.x) <= half.x && Math.abs(mid.y - screen.y) <= half.y) return "body";
  }
  return null;
}

/**
 * Where an end lands for a pointer at `at`: attached to the shape under it,
 * else free. `other` is the shape the far end holds, which this end may not share.
 */
function endAt(host: CanvasExtensionHost, id: string, at: CanvasPoint, other?: string): LineEnd {
  const target = host.shapeAt(at, id);
  host.setTargetHighlight(target && target.id !== other ? target.id : null);
  if (!target || target.id === other) return { x: at.x, y: at.y };
  return { x: at.x, y: at.y, shape: target.id };
}

function dragEnd(shape: CanvasShape, host: CanvasExtensionHost, which: "start" | "end"): CanvasPointerGestureHandlers {
  const otherKey = which === "start" ? "end" : "start";
  const other = lineEnd(shape.data[otherKey]).shape;
  const finish = () => host.setTargetHighlight(null);
  return {
    onMove: ({ world }) => host.updateData(shape.id, { [which]: endAt(host, shape.id, world, other) }),
    onEnd: finish,
    onCancel: finish,
  };
}

/** The line's ends as stored, but moved to where they are drawn, so a free end never jumps. */
function settledEnds(shape: CanvasShape) {
  const { points } = geometry(shape);
  const settle = (value: unknown, at: CanvasPoint): LineEnd => ({ ...lineEnd(value), x: at.x, y: at.y });
  return { start: settle(shape.data.start, points[0]), end: settle(shape.data.end, points[points.length - 1]) };
}

export const CanvasLine = CanvasElement.create({
  name: "line",

  addDefaults() {
    return {
      size: { width: 1, height: 1 },
      minSize: { width: 0, height: 0 },
      style: { color: "#334155" },
      data: {
        start: { x: 0, y: 0 },
        end: { x: 160, y: 0 },
        route: "straight",
        endHead: "arrow",
        startHead: "none",
        text: "",
      },
    };
  },

  addRender() {
    return {
      paint: paintLine,
      hitTest: hitTestLine,
      cursor: (_shape, region) => (region === "body" ? "move" : "crosshair"),
      handles: (shape) => {
        const { points } = geometry(shape);
        return [points[0], points[points.length - 1]];
      },
    };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: false, handles: "none" as const },
      press: (_shape, region) => (region === "start" || region === "end" ? "grab" : "drag"),
      resolve: (shape, lookup) => {
        const resolved = resolveLine(shape.data, lookup, 0.5);
        const style = lineStyle(shape.data);
        const pad = 8 + style.width * 3;
        const bounds = polygonBounds([resolved.points]);
        return {
          ...shape,
          frame: {
            x: bounds.x - pad,
            y: bounds.y - pad,
            width: bounds.width + pad * 2,
            height: bounds.height + pad * 2,
            rotation: 0,
          },
          derived: { geometry: resolved },
        };
      },
      // An end attached to something not copied with it lets go where it is drawn.
      rebind: (shape, copies) => {
        const ends = settledEnds(shape);
        const follow = (end: LineEnd) => {
          const copy = end.shape && copies.get(end.shape);
          return copy ? { ...end, shape: copy } : { x: end.x, y: end.y };
        };
        return { start: follow(ends.start), end: follow(ends.end) };
      },
      // Only free ends move: an attached end follows its shape.
      reshape: (shape, map) => {
        const ends = settledEnds(shape);
        const move = (end: LineEnd) => (end.shape ? end : { ...end, ...map(end) });
        return {
          start: move(ends.start),
          end: move(ends.end),
          ...(Array.isArray(shape.data.via) ? { via: lineVia(shape.data).map(map) } : {}),
        };
      },
    };
  },

  addEvents() {
    return {
      grab: (shape, host, region) => dragEnd(shape, host, region === "start" ? "start" : "end"),
      doubleClick: (shape, host) =>
        host.editText({
          shapeId: shape.id,
          field: "text",
          label: "Label",
          value: labelText(shape),
          commit: (text) => host.updateData(shape.id, { text }),
        }),
    };
  },

  addProperties() {
    return [
      {
        kind: "swatches",
        id: "stroke",
        label: "Color",
        options: STROKE_COLORS.filter((color) => color !== "transparent"),
        default: "#334155",
      },
      {
        kind: "select",
        id: "route",
        label: "Route",
        options: [
          { value: "straight", label: "Straight" },
          { value: "elbow", label: "Elbow" },
          { value: "curve", label: "Curve" },
        ],
        default: "straight",
      },
      {
        kind: "select",
        id: "endHead",
        label: "End",
        options: [
          { value: "none", label: "None" },
          { value: "arrow", label: "Arrow" },
          { value: "triangle", label: "Triangle" },
          { value: "circle", label: "Circle" },
        ],
        default: "arrow",
      },
      {
        kind: "select",
        id: "startHead",
        label: "Start",
        options: [
          { value: "none", label: "None" },
          { value: "arrow", label: "Arrow" },
          { value: "triangle", label: "Triangle" },
          { value: "circle", label: "Circle" },
        ],
        default: "none",
      },
      {
        kind: "select",
        id: "strokeWidth",
        label: "Width",
        options: [
          { value: 1, label: "Thin" },
          { value: 2, label: "Medium" },
          { value: 4, label: "Thick" },
        ],
        default: 2,
      },
      {
        kind: "select",
        id: "dash",
        label: "Style",
        options: [
          { value: "solid", label: "Solid" },
          { value: "dashed", label: "Dashed" },
          { value: "dotted", label: "Dotted" },
        ],
        default: "solid",
      },
    ] as const;
  },
});

/**
 * Draws a line by dragging from one end to the other; an end let go over a
 * shape attaches to it. A click without a drag places a short arrow.
 */
export const LineTool = CanvasTool.create({
  name: "line",
  shortcut: "A",
  toolbar: { label: "Arrow", icon: iconMarkup("arrow-tool") },
  onPointerDown(at, event, ctx) {
    const id = `shape-${crypto.randomUUID()}`;
    const start = endAt(ctx.host, id, at);
    ctx.host.setTargetHighlight(null);
    ctx.insertShape({
      id,
      type: "line",
      frame: { x: at.x, y: at.y, width: 1, height: 1, rotation: 0 },
      style: { color: "#334155" },
      data: { ...CanvasLine.defaults.data, start, end: { x: at.x, y: at.y } },
      updatedAt: Date.now(),
    });
    let moved = false;
    const finish = (world: CanvasPoint | null) => {
      ctx.host.setTargetHighlight(null);
      if (!moved) {
        ctx.host.updateData(id, { end: { x: at.x + 160, y: at.y } });
      } else if (world) {
        ctx.host.updateData(id, { end: endAt(ctx.host, id, world, start.shape) });
        ctx.host.setTargetHighlight(null);
      }
      ctx.setActiveTool("select");
    };
    ctx.beginPointerGesture(event, {
      onMove: ({ world }) => {
        if (Math.hypot(world.x - at.x, world.y - at.y) * ctx.viewportScale() < 4) return;
        moved = true;
        ctx.host.updateData(id, { end: endAt(ctx.host, id, world, start.shape) });
      },
      onEnd: ({ world }) => finish(world),
      onCancel: () => finish(null),
    });
    event.preventDefault();
  },
});
