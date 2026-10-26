/**
 * The canvas as an agent reads and writes it: flat elements addressed by id,
 * named by what they look like ("rect", "arrow", "slide"), positioned relative
 * to the frame they sit in. Writes are validated strictly and answered with
 * warnings about overflowing text, overlaps and elements leaving their frame,
 * so a model can see what went wrong without looking.
 */

import type { Font } from "#canvas/render/font.ts";
import type { FontFace } from "#canvas/render/fonts.ts";
import {
  GEO_KINDS,
  GEO_PARAGRAPH_GAP,
  type GeoKind,
  type GeoStyle,
  geoLabelBox,
  geoStyle,
  type LineEnd,
  lineEnd,
  lineStyle,
  lineVia,
  lineLabelCenter,
  resolveLine,
} from "#canvas/render/shapeGeometry.ts";
import { parseColor } from "#canvas/render/webgl.ts";
import { layoutChart } from "#canvas/agent/chart.ts";
import { layoutDiagram, sizeForText } from "#canvas/agent/layout.ts";
import {
  contains,
  overlap,
  parentFrames,
  type Rect,
  type StoredShape,
  type StoredSnapshot,
  sceneShapes,
  shapeBounds,
} from "#canvas/agent/model.ts";
import { layoutMarkdown } from "#canvas/raster/text.ts";
import type { SceneShape } from "#canvas/raster/scene.ts";

export type AgentElement = Record<string, unknown> & { id: string; type: string };

const SLIDE = { width: 1920, height: 1080, gap: 200 };
const SLIDE_TITLE = { x: 120, y: 90, w: 1680, fontSize: 64 };
const TEXT_DEFAULT_SIZE = 24;
const round = (value: number) => Math.round(value * 10) / 10;

/** Which agent type a stored shape reads as. */
function agentType(shape: SceneShape): string {
  if (shape.type === "section") return shape.data.slide === true ? "slide" : "frame";
  if (shape.type === "line") {
    return lineStyle(shape.data).end === "none" && lineStyle(shape.data).start === "none" ? "line" : "arrow";
  }
  if (shape.type !== "geo") return shape.type;
  const style = geoStyle(shape.data);
  if (style.kind === "rect" && shape.style.color === "transparent" && style.strokeWidth === 0) return "text";
  return style.kind;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function describeEnd(end: LineEnd, origin: { x: number; y: number }) {
  if (!end.shape) return [round(end.x - origin.x), round(end.y - origin.y)];
  return end.anchor ? { id: end.shape, anchor: [end.anchor.x, end.anchor.y] } : end.shape;
}

/** One element as the agent sees it: only what differs from the defaults. */
function describeShape(shape: SceneShape, parent: SceneShape | undefined): AgentElement {
  const origin = parent ? { x: parent.frame.x, y: parent.frame.y } : { x: 0, y: 0 };
  const type = agentType(shape);
  const element: AgentElement = { id: shape.id, type };
  if (parent) element.in = parent.id;
  const data = shape.data;
  if (typeof data.group === "string") element.group = data.group;
  if (shape.type === "line") {
    const style = lineStyle(data);
    element.from = describeEnd(lineEnd(data.start), origin);
    element.to = describeEnd(lineEnd(data.end), origin);
    const via = lineVia(data);
    if (via.length > 0) element.via = via.map((point) => [round(point.x - origin.x), round(point.y - origin.y)]);
    if (style.route !== "straight") element.route = style.route;
    if (type === "arrow" && !(style.end === "arrow" && style.start === "none")) {
      element.startHead = style.start;
      element.endHead = style.end;
    }
    if (style.color !== "#334155") element.stroke = style.color;
    if (style.width !== 2) element.strokeWidth = style.width;
    if (style.dash !== "solid") element.dash = style.dash;
    if (typeof data.text === "string" && data.text) element.label = data.text;
    if (style.labelAt !== 0.5) element.labelAt = style.labelAt;
    if (style.fontSize !== 14) element.fontSize = style.fontSize;
    return element;
  }
  Object.assign(element, {
    x: round(shape.frame.x - origin.x),
    y: round(shape.frame.y - origin.y),
    w: round(shape.frame.width),
    h: round(shape.frame.height),
  });
  if (shape.frame.rotation) element.rotation = shape.frame.rotation;
  if (shape.type === "section") {
    element.title = data.text ?? "";
    if (typeof data.background === "string") element.background = data.background;
    if (shape.style.color !== "transparent") element.fill = shape.style.color;
    if (data.clip === true) element.clip = true;
    return element;
  }
  if (typeof data.text === "string" && data.text) element.text = data.text;
  if (shape.type === "geo") {
    const style = geoStyle(data);
    if (type !== "text") {
      element.fill = shape.style.color;
      if (style.stroke !== "#334155") element.stroke = style.stroke;
      if (style.strokeWidth !== 2) element.strokeWidth = style.strokeWidth;
    }
    if (style.kind === "path") {
      element.points = (Array.isArray(data.points) ? data.points : []).map((point) => {
        const { x, y } = point as { x: number; y: number };
        return [round(x * shape.frame.width), round(y * shape.frame.height)];
      });
      if (data.closed === false) element.closed = false;
    }
    if (style.dash !== "solid") element.dash = style.dash;
    if (style.radius) element.radius = style.radius;
    if (style.fontSize !== (type === "text" ? TEXT_DEFAULT_SIZE : 18)) element.fontSize = style.fontSize;
    if (style.padding !== (type === "text" ? 0 : 12)) element.padding = style.padding;
    if (style.textColor) element.textColor = style.textColor;
    if (style.align !== (type === "text" ? "start" : "center")) element.align = style.align;
    if (style.valign !== (type === "text" ? "top" : "middle")) element.valign = style.valign;
    return element;
  }
  if (shape.type === "note") {
    element.fill = shape.style.color;
    if (typeof data.fontSize === "number") element.fontSize = data.fontSize;
  }
  if (shape.type === "text" && Number(data.fontScale) && Number(data.fontScale) !== 1) {
    element.fontSize = round(15 * Number(data.fontScale));
  }
  for (const key of ["src", "url", "title", "documentId"]) {
    if (typeof data[key] === "string") element[key] = data[key];
  }
  return element;
}

export function describeCanvas(snapshot: StoredSnapshot, faces: ReadonlyMap<FontFace, Font>) {
  const shapes = sceneShapes(snapshot, faces).sort(
    (a, b) => (a.type === "section" ? -1 : 0) - (b.type === "section" ? -1 : 0) || a.z - b.z,
  );
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  const parents = parentFrames(shapes);
  const elements = shapes.map((shape) => describeShape(shape, byId.get(parents.get(shape.id) ?? "")));
  const all = shapes.map((shape) => shapeBounds(shape, (id) => byId.get(id)));
  const strokes = snapshot.strokes.length;
  return {
    elements,
    ...(strokes > 0 ? { drawings: strokes } : {}),
    bounds: all.length > 0 ? roundRect(union(all)) : null,
  };
}

function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

function roundRect(rect: Rect) {
  return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const COMMON = ["id", "type", "in", "x", "y", "w", "h", "rotation"];
const GEO_FIELDS = [...COMMON, "text", "fill", "stroke", "strokeWidth", "dash", "radius", "fontSize", "textColor", "align", "valign", "padding"];
const ARROW_FIELDS = ["id", "type", "in", "from", "to", "via", "route", "startHead", "endHead", "stroke", "strokeWidth", "dash", "label", "labelAt", "fontSize"];
const FIELDS: Record<string, readonly string[]> = {
  ...Object.fromEntries(GEO_KINDS.map((kind) => [kind, kind === "path" ? [...GEO_FIELDS, "points", "closed"] : GEO_FIELDS])),
  circle: GEO_FIELDS,
  text: [...COMMON, "text", "fontSize", "textColor", "align", "valign", "fill", "stroke", "strokeWidth", "padding"],
  note: [...COMMON, "text", "fill", "fontSize"],
  frame: [...COMMON, "title", "fill", "background", "clip"],
  slide: [...COMMON, "title", "fill", "background", "clip"],
  line: ARROW_FIELDS,
  arrow: ARROW_FIELDS,
  image: [...COMMON, "src", "alt"],
};
const OPTIONS: Record<string, readonly (string | number)[]> = {
  dash: ["solid", "dashed", "dotted"],
  align: ["start", "center", "end"],
  valign: ["top", "middle", "bottom"],
  route: ["straight", "elbow", "curve"],
  startHead: ["none", "arrow", "triangle", "circle", "diamond"],
  endHead: ["none", "arrow", "triangle", "circle", "diamond"],
};

class CanvasEditError extends Error {}

function fail(message: string): never {
  throw new CanvasEditError(message);
}

function checkFields(spec: Record<string, unknown>, type: string, at: string) {
  const allowed = FIELDS[type];
  if (type === "chart" || type === "diagram") fail(`${at}: ${type} is an operation, not a type: {"op": "${type}", …}.`);
  if (!allowed) fail(`${at}: unknown type "${type}". Types: ${Object.keys(FIELDS).join(", ")}.`);
  for (const [key, value] of Object.entries(spec)) {
    if (key === "op") continue;
    if (!allowed.includes(key)) fail(`${at}: "${type}" has no field "${key}". Fields: ${allowed.join(", ")}.`);
    if (OPTIONS[key] && !OPTIONS[key].includes(value as string)) {
      fail(`${at}: ${key} must be one of ${OPTIONS[key].join(", ")}.`);
    }
    if (["fill", "stroke", "textColor", "background"].includes(key)) {
      if (typeof value !== "string") fail(`${at}: ${key} must be a colour string.`);
      try {
        parseColor(value);
      } catch {
        fail(`${at}: ${key} "${value}" is not a colour; use #rrggbb, rgba() or "transparent".`);
      }
    }
    if (["x", "y", "w", "h", "rotation", "strokeWidth", "radius", "fontSize", "padding", "labelAt"].includes(key) && typeof value !== "number") {
      fail(`${at}: ${key} must be a number.`);
    }
  }
}

interface EditState {
  snapshot: StoredSnapshot;
  faces: ReadonlyMap<FontFace, Font>;
  now: number;
  z: number;
  touched: Set<string>;
  created: string[];
  /** The frame each element was placed in, to warn when it does not fit there. */
  placed: Map<string, string>;
}

function scene(state: EditState) {
  const shapes = sceneShapes(state.snapshot, state.faces);
  return { shapes, byId: new Map(shapes.map((shape) => [shape.id, shape])) };
}

function stored(state: EditState, id: string): StoredShape {
  const shape = state.snapshot.shapes.find((candidate) => candidate.id === id);
  if (!shape) fail(`No element "${id}". Read the canvas for the current ids.`);
  return shape;
}

/** An unused id for a diagram or chart, which names its parts without being one. */
function freshGroup(state: EditState, op: string) {
  const taken = new Set(state.snapshot.shapes.flatMap((shape) => [shape.id, String(shape.data.group ?? "")]));
  for (let n = 1; ; n++) if (!taken.has(`${op}-${n}`) && !taken.has(`${op}-${n}-label-0`)) return `${op}-${n}`;
}

function freshId(state: EditState, type: string) {
  const taken = new Set(state.snapshot.shapes.map((shape) => shape.id));
  for (let n = 1; ; n++) if (!taken.has(`${type}-${n}`)) return `${type}-${n}`;
}

/** The origin coordinates are relative to: the named frame, else none. */
function originOf(state: EditState, frameId: unknown, at: string) {
  if (frameId === undefined || frameId === null) return { x: 0, y: 0 };
  if (typeof frameId !== "string") fail(`${at}: in must be a frame id.`);
  const frame = stored(state, frameId);
  if (frame.type !== "section") fail(`${at}: "${frameId}" is not a frame or slide.`);
  return { x: frame.frame.x, y: frame.frame.y };
}

/** Where coordinates in an update are relative to: `in` when given, else the frame it is in now. */
function updateOrigin(state: EditState, id: string, spec: Record<string, unknown>, at: string) {
  if ("in" in spec) return originOf(state, spec.in, at);
  const { shapes } = scene(state);
  return originOf(state, parentFrames(shapes).get(id), at);
}

/** A shape's own text as it lays out, blank-line gaps included. */
function geoText(state: EditState, text: string, style: GeoStyle, width: number) {
  return layoutMarkdown(
    text,
    { size: style.fontSize, color: "#000", align: style.align, paragraphGap: GEO_PARAGRAPH_GAP },
    width,
    state.faces,
  );
}

function measureText(state: EditState, text: string, fontSize: number, width: number, align?: string) {
  return layoutMarkdown(text, { size: fontSize, color: "#000", align: align as "start" }, width, state.faces);
}

function parseEnd(state: EditState, value: unknown, origin: { x: number; y: number }, at: string): LineEnd {
  if (typeof value === "string") {
    stored(state, value);
    return { x: 0, y: 0, shape: value };
  }
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number")) {
    return { x: origin.x + value[0], y: origin.y + value[1] };
  }
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    const { id, anchor } = value as { id: string; anchor?: unknown };
    stored(state, id);
    const named: Record<string, [number, number]> = {
      top: [0.5, 0],
      bottom: [0.5, 1],
      left: [0, 0.5],
      right: [1, 0.5],
      center: [0.5, 0.5],
    };
    const point = (typeof anchor === "string" ? named[anchor] : anchor) as number[] | undefined;
    if (anchor !== undefined && !(Array.isArray(point) && point.length === 2)) {
      fail(`${at}: anchor must be top, bottom, left, right, center or [x, y] from 0 to 1.`);
    }
    return { x: 0, y: 0, shape: id, ...(point ? { anchor: { x: point[0], y: point[1] } } : {}) };
  }
  fail(`${at}: an end is an element id, {"id", "anchor"} or a point [x, y].`);
}

/** Applies a line spec's fields onto its data. */
function lineData(state: EditState, spec: Record<string, unknown>, origin: { x: number; y: number }, at: string, data: Record<string, unknown>) {
  if ("from" in spec) data.start = parseEnd(state, spec.from, origin, `${at} from`);
  if ("to" in spec) data.end = parseEnd(state, spec.to, origin, `${at} to`);
  if ("via" in spec) {
    const via = spec.via;
    if (!Array.isArray(via) || !via.every((point) => Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === "number"))) {
      fail(`${at}: via must be a list of points [[x, y], …].`);
    }
    data.via = (via as number[][]).map(([x, y]) => ({ x: origin.x + x, y: origin.y + y }));
  }
  for (const key of ["route", "startHead", "endHead", "stroke", "strokeWidth", "dash", "fontSize", "labelAt"]) {
    if (key in spec) data[key] = spec[key];
  }
  if ("label" in spec) data.text = spec.label;
  return data;
}

function geoData(spec: Record<string, unknown>, data: Record<string, unknown>) {
  for (const key of ["text", "stroke", "strokeWidth", "dash", "radius", "fontSize", "textColor", "align", "valign", "padding"]) {
    if (key in spec) data[key] = spec[key];
  }
  return data;
}

/** A text box or note grows to its text; `h` given explicitly wins. */
function fitHeight(state: EditState, shape: StoredShape, spec: Record<string, unknown>, kind: "text" | "note") {
  if ("h" in spec) return;
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  if (kind === "note") {
    const size = typeof shape.data.fontSize === "number" ? shape.data.fontSize : 15;
    const layout = measureText(state, text, size, (shape.frame.width ?? 180) - 26);
    shape.frame.height = Math.max(96, Math.ceil(layout.height + 26));
    return;
  }
  const style = geoStyle(shape.data);
  const layout = geoText(state, text, style, (shape.frame.width ?? 0) - style.padding * 2);
  shape.frame.height = Math.ceil(layout.height + style.padding * 2);
}

/** A text box made without a width grows and shrinks to its one line. */
function fitWidth(state: EditState, shape: StoredShape) {
  const style = geoStyle(shape.data);
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  const natural = geoText(state, text, style, Number.POSITIVE_INFINITY);
  shape.frame.width = Math.ceil(natural.width + style.padding * 2 + 2);
}

function addElement(state: EditState, spec: Record<string, unknown>, at: string) {
  const type = spec.type;
  if (typeof type !== "string") fail(`${at}: add needs a type. Types: ${Object.keys(FIELDS).join(", ")}.`);
  checkFields(spec, type, at);
  const id = spec.id === undefined ? freshId(state, type) : spec.id;
  if (typeof id !== "string" || !id || id.startsWith("stroke-")) fail(`${at}: id must be a non-empty string.`);
  if (state.snapshot.shapes.some((shape) => shape.id === id)) {
    fail(`${at}: id "${id}" already exists; use op "update" to change it.`);
  }
  const origin = originOf(state, spec.in, at);
  // On a slide, text is read from across a room: defaults scale up.
  const onSlide = typeof spec.in === "string" && stored(state, spec.in).data.slide === true;
  if (onSlide && spec.fontSize === undefined) {
    const size = { note: 24, arrow: 24, line: 24, text: 32 }[type as "note"] ?? (FIELDS[type]?.includes("fontSize") ? 28 : undefined);
    if (size !== undefined) spec = { ...spec, fontSize: size };
  }
  const base = (storedType: string, color: string, data: Record<string, unknown>, size: { width: number; height: number }): StoredShape => {
    if (type !== "slide" && (typeof spec.x !== "number" || typeof spec.y !== "number")) {
      fail(`${at}: ${type} needs x and y.`);
    }
    return {
      id,
      type: storedType,
      frame: {
        x: origin.x + (spec.x as number),
        y: origin.y + (spec.y as number),
        width: (spec.w as number | undefined) ?? size.width,
        height: (spec.h as number | undefined) ?? size.height,
        rotation: (spec.rotation as number | undefined) ?? 0,
      },
      style: { color },
      data,
      updatedAt: state.now,
      z: state.z++,
    };
  };

  let shape: StoredShape;
  if (type === "line" || type === "arrow") {
    if (spec.from === undefined || spec.to === undefined) fail(`${at}: a ${type} needs from and to.`);
    const data = lineData(state, spec, origin, at, {
      route: "straight",
      startHead: "none",
      endHead: type === "arrow" ? "arrow" : "none",
      text: "",
    });
    shape = { id, type: "line", frame: { x: 0, y: 0, width: 1, height: 1, rotation: 0 }, style: { color: "#334155" }, data, updatedAt: state.now, z: state.z++ };
  } else if (type === "frame" || type === "slide") {
    if (type === "slide" && spec.x === undefined && spec.y === undefined) {
      const frames = state.snapshot.shapes.filter((candidate) => candidate.type === "section");
      const right = Math.max(-SLIDE.gap, ...frames.map((frame) => frame.frame.x + (frame.frame.width ?? 0)));
      spec = { ...spec, x: right + SLIDE.gap - origin.x, y: (frames[0]?.frame.y ?? 0) - origin.y };
    }
    shape = base(
      "section",
      (spec.fill as string | undefined) ?? "transparent",
      {
        text: spec.title ?? "",
        ...(spec.clip ? { clip: true } : {}),
        ...(typeof spec.background === "string" ? { background: spec.background } : {}),
        ...(type === "slide" ? { slide: true } : {}),
      },
      type === "slide" ? SLIDE : { width: 560, height: 340 },
    );
  } else if (type === "note") {
    shape = base("note", (spec.fill as string | undefined) ?? "#fef3c7", { text: spec.text ?? "", ...(typeof spec.fontSize === "number" ? { fontSize: spec.fontSize } : {}) }, { width: 220, height: 120 });
    fitHeight(state, shape, spec, "note");
  } else if (type === "text") {
    const data = geoData(spec, { kind: "rect", text: "", strokeWidth: 0, align: "start", valign: "top", fontSize: TEXT_DEFAULT_SIZE, padding: 0 });
    if (spec.w === undefined) data.autoWidth = true;
    shape = base("geo", (spec.fill as string | undefined) ?? "transparent", data, { width: 0, height: 0 });
    if (data.autoWidth) fitWidth(state, shape);
    fitHeight(state, shape, spec, "text");
  } else if (type === "image") {
    if (typeof spec.src !== "string") fail(`${at}: an image needs src, a URL.`);
    shape = base("image", "transparent", { text: "", src: spec.src, alt: spec.alt ?? "" }, { width: 400, height: 300 });
  } else {
    const kind = (type === "circle" ? "ellipse" : type) as GeoKind;
    const data = geoData(spec, { kind, text: "" });
    const style = geoStyle(data);
    // Left out, a size fits the text; there is nothing to fit without any.
    let size = String(data.text).trim()
      ? sizeForText(
          { kind, text: String(data.text), fontSize: style.fontSize, padding: style.padding, w: spec.w as number | undefined, h: spec.h as number | undefined },
          state.faces,
        )
      : kind === "rect"
        ? { width: 200, height: 100 }
        : { width: 140, height: 140 };
    if (kind === "path") {
      const points = spec.points;
      if (!Array.isArray(points) || points.length < 2 || !points.every((point) => Array.isArray(point) && point.length === 2)) {
        fail(`${at}: a path needs points, [[x, y], …] relative to its x, y.`);
      }
      const xs = (points as number[][]).map((point) => point[0]);
      const ys = (points as number[][]).map((point) => point[1]);
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      size = { width: Math.max(1, Math.max(...xs) - x0), height: Math.max(1, Math.max(...ys) - y0) };
      data.points = (points as number[][]).map(([x, y]) => ({ x: (x - x0) / size.width, y: (y - y0) / size.height }));
      data.closed = spec.closed !== false;
      spec = { ...spec, x: (spec.x as number) + x0, y: (spec.y as number) + y0, w: size.width, h: size.height };
    }
    shape = base("geo", (spec.fill as string | undefined) ?? "#ffffff", data, size);
  }
  state.snapshot.shapes.push(shape);
  if (typeof spec.in === "string") state.placed.set(id, spec.in);
  state.touched.add(id);
  state.created.push(id);
  // A slide's title is shown on the slide, as its first text box.
  if (type === "slide" && typeof spec.title === "string" && spec.title) {
    addElement(state, { type: "text", id: `${id}-title`, in: id, ...SLIDE_TITLE, text: `**${spec.title}**` }, `${at} (title)`);
  }
}

function updateElement(state: EditState, spec: Record<string, unknown>, at: string) {
  if (typeof spec.id !== "string") fail(`${at}: update needs the id of an element.`);
  const shape = stored(state, spec.id);
  const current = scene(state).byId.get(spec.id);
  if (!current) fail(`${at}: "${spec.id}" cannot be read.`);
  const type = agentType(current);
  if (spec.type !== undefined && spec.type !== type) {
    const geo = new Set<string>([...GEO_KINDS, "circle"]);
    if (!(geo.has(type) && geo.has(spec.type as string) && spec.type !== "path")) {
      fail(`${at}: a ${type} cannot become a ${String(spec.type)}; delete it and add a new one.`);
    }
    shape.data.kind = spec.type === "circle" ? "ellipse" : spec.type;
  }
  checkFields(spec, (spec.type as string | undefined) ?? type, at);
  const origin = updateOrigin(state, spec.id, spec, at);
  if (typeof spec.in === "string") state.placed.set(spec.id, spec.in);
  if (shape.type === "line") {
    lineData(state, spec, origin, at, shape.data);
  } else {
    if (typeof spec.x === "number") shape.frame.x = origin.x + spec.x;
    if (typeof spec.y === "number") shape.frame.y = origin.y + spec.y;
    if ("in" in spec && typeof spec.x !== "number") fail(`${at}: moving into a frame needs x and y within it.`);
    if (typeof spec.w === "number") shape.frame.width = spec.w;
    if (typeof spec.h === "number") shape.frame.height = spec.h;
    if (typeof spec.rotation === "number") shape.frame.rotation = spec.rotation;
    if (typeof spec.fill === "string") shape.style.color = spec.fill;
    if (shape.type === "section") {
      if ("title" in spec) {
        shape.data.text = spec.title;
        const title = state.snapshot.shapes.find((candidate) => candidate.id === `${spec.id}-title`);
        if (shape.data.slide === true && title) {
          title.data.text = `**${String(spec.title)}**`;
          fitHeight(state, title, {}, "text");
        }
      }
      if ("clip" in spec) shape.data.clip = spec.clip === true;
      if (typeof spec.background === "string") shape.data.background = spec.background;
    } else if (shape.type === "geo") {
      geoData(spec, shape.data);
      if (type === "text") {
        if ("w" in spec) delete shape.data.autoWidth;
        else if (shape.data.autoWidth && ("text" in spec || "fontSize" in spec || "padding" in spec)) fitWidth(state, shape);
        fitHeight(state, shape, spec, "text");
      } else if (!("h" in spec) && ["text", "fontSize", "padding", "type", "w"].some((key) => key in spec)) {
        // Grows to hold new text; never shrinks a size someone chose.
        const style = geoStyle(shape.data);
        if (style.kind !== "path" && String(shape.data.text ?? "").trim()) {
          const fitted = sizeForText(
            { kind: style.kind, text: String(shape.data.text), fontSize: style.fontSize, padding: style.padding, w: shape.frame.width },
            state.faces,
          );
          shape.frame.height = Math.max(shape.frame.height ?? 0, fitted.height);
        }
      }
    } else if (shape.type === "text") {
      if ("text" in spec) shape.data.text = spec.text;
      if (typeof spec.fontSize === "number") shape.data.fontScale = spec.fontSize / 15;
    } else if (shape.type === "note") {
      if ("text" in spec) shape.data.text = spec.text;
      if (typeof spec.fontSize === "number") shape.data.fontSize = spec.fontSize;
      if ("text" in spec || "fontSize" in spec || "w" in spec) fitHeight(state, shape, spec, "note");
    } else if ("text" in spec) {
      shape.data.text = spec.text;
    }
    if (shape.type === "image" && typeof spec.src === "string") shape.data.src = spec.src;
  }
  shape.updatedAt = state.now;
  state.touched.add(spec.id);
}

function deleteElements(state: EditState, ids: unknown, at: string) {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) fail(`${at}: delete needs ids, a list of element ids.`);
  const { byId } = scene(state);
  // A diagram's or chart's id stands for all its parts.
  const gone = new Set<string>();
  for (const id of ids) {
    const parts = state.snapshot.shapes.filter((shape) => shape.data.group === id);
    if (parts.length > 0) for (const part of parts) gone.add(part.id);
    else gone.add(stored(state, id).id);
  }
  // A line attached to something deleted keeps its end where it was drawn.
  for (const shape of state.snapshot.shapes) {
    if (shape.type !== "line" || gone.has(shape.id)) continue;
    const resolved = resolveLine(shape.data, (id) => byId.get(id), 0.5);
    for (const [key, at] of [["start", resolved.points[0]], ["end", resolved.points[resolved.points.length - 1]]] as const) {
      const end = lineEnd(shape.data[key]);
      if (end.shape && gone.has(end.shape)) shape.data[key] = { x: at.x, y: at.y };
    }
  }
  state.snapshot.shapes = state.snapshot.shapes.filter((shape) => !gone.has(shape.id));
}

function reorder(state: EditState, ids: unknown, front: boolean, at: string) {
  if (!Array.isArray(ids)) fail(`${at}: needs ids.`);
  const zs = state.snapshot.shapes.map((shape) => shape.z ?? shape.updatedAt);
  let z = front ? Math.max(state.z, ...zs) + 1 : Math.min(...zs) - ids.length;
  for (const id of ids) stored(state, String(id)).z = z++;
  state.z = Math.max(state.z, z);
}

/** Moves shapes so one edge or centre line matches across them. */
function alignElements(state: EditState, spec: Record<string, unknown>, at: string) {
  const edges = ["left", "center", "right", "top", "middle", "bottom"];
  if (!Array.isArray(spec.ids) || spec.ids.length < 2) fail(`${at}: align needs ids, two or more.`);
  if (!edges.includes(spec.edge as string)) fail(`${at}: edge must be one of ${edges.join(", ")}.`);
  const shapes = (spec.ids as unknown[]).map((id) => stored(state, String(id)));
  if (shapes.some((shape) => shape.type === "line")) fail(`${at}: lines follow what they join; align the shapes instead.`);
  const horizontal = ["left", "center", "right"].includes(spec.edge as string);
  const start = (shape: StoredShape) => (horizontal ? shape.frame.x : shape.frame.y);
  const size = (shape: StoredShape) => (horizontal ? (shape.frame.width ?? 0) : (shape.frame.height ?? 0));
  const low = Math.min(...shapes.map(start));
  const high = Math.max(...shapes.map((shape) => start(shape) + size(shape)));
  for (const shape of shapes) {
    const value =
      spec.edge === "left" || spec.edge === "top"
        ? low
        : spec.edge === "right" || spec.edge === "bottom"
          ? high - size(shape)
          : (low + high) / 2 - size(shape) / 2;
    if (horizontal) shape.frame.x = value;
    else shape.frame.y = value;
    shape.updatedAt = state.now;
    state.touched.add(shape.id);
  }
}

/** Spaces shapes evenly along an axis, in their current order, or `gap` apart. */
function distributeElements(state: EditState, spec: Record<string, unknown>, at: string) {
  if (!Array.isArray(spec.ids) || spec.ids.length < 3) fail(`${at}: distribute needs ids, three or more.`);
  if (spec.axis !== "x" && spec.axis !== "y") fail(`${at}: axis must be x or y.`);
  if (spec.gap !== undefined && typeof spec.gap !== "number") fail(`${at}: gap must be a number.`);
  const axis = spec.axis;
  const size = (shape: StoredShape) => (axis === "x" ? (shape.frame.width ?? 0) : (shape.frame.height ?? 0));
  const shapes = (spec.ids as unknown[])
    .map((id) => stored(state, String(id)))
    .sort((a, b) => a.frame[axis] - b.frame[axis]);
  const first = shapes[0];
  const last = shapes[shapes.length - 1];
  const total = shapes.reduce((sum, shape) => sum + size(shape), 0);
  const gap =
    typeof spec.gap === "number" ? spec.gap : (last.frame[axis] + size(last) - first.frame[axis] - total) / (shapes.length - 1);
  let cursor = first.frame[axis];
  for (const shape of shapes) {
    shape.frame[axis] = cursor;
    cursor += size(shape) + gap;
    shape.updatedAt = state.now;
    state.touched.add(shape.id);
  }
}

export interface CanvasEditResult {
  created: string[];
  warnings: string[];
  /** The box each diagram or chart filled, relative to its frame, by its id. */
  placed?: Record<string, { x: number; y: number; w: number; h: number }>;
  /** Bounds of each frame that was touched, so follow-up placement knows the space. */
  frames: Record<string, { x: number; y: number; w: number; h: number }>;
}

/**
 * Applies `operations` to a copy of `snapshot`; any failing operation rejects
 * the batch with a message naming it.
 */
export function applyCanvasOperations(
  snapshot: StoredSnapshot,
  operations: unknown,
  faces: ReadonlyMap<FontFace, Font>,
): { snapshot: StoredSnapshot; result: CanvasEditResult } {
  if (!Array.isArray(operations) || operations.length === 0) fail("operations must be a non-empty list.");
  const now = Date.now();
  const copy = structuredClone(snapshot);
  const state: EditState = {
    snapshot: copy,
    faces,
    now,
    z: Math.max(now, ...copy.shapes.map((shape) => (shape.z ?? shape.updatedAt) + 1)),
    touched: new Set(),
    created: [],
    placed: new Map(),
  };
  const placed: NonNullable<CanvasEditResult["placed"]> = {};
  operations.forEach((raw, index) => {
    const at = `operation ${index + 1}`;
    if (!raw || typeof raw !== "object") fail(`${at}: must be an object with "op".`);
    const { op: written, ...given } = raw as Record<string, unknown>;
    // A chart or diagram written as an element type means the operation.
    const generated = written === "add" && (given.type === "chart" || given.type === "diagram");
    const op = generated ? given.type : written;
    const { type: _type, ...rest } = given;
    const spec = generated ? rest : given;
    if (op === "add") addElement(state, spec, at);
    else if (op === "update" && Array.isArray(spec.ids)) {
      const { ids, ...fields } = spec;
      for (const id of ids) updateElement(state, { ...fields, id }, `${at} (${String(id)})`);
    } else if (op === "update") updateElement(state, spec, at);
    else if (op === "align") alignElements(state, spec, at);
    else if (op === "distribute") distributeElements(state, spec, at);
    else if (op === "delete") deleteElements(state, spec.ids, at);
    else if (op === "front" || op === "back") reorder(state, spec.ids, op === "front", at);
    else if (op === "diagram" || op === "chart") {
      const context = {
        faces,
        at,
        fail,
        exists: (id: string) => state.snapshot.shapes.some((shape) => shape.id === id),
        frameSize: (id: string) => {
          originOf(state, id, at);
          const frame = stored(state, id).frame;
          return { width: frame.width ?? 0, height: frame.height ?? 0 };
        },
      };
      if (spec.id !== undefined && typeof spec.id !== "string") fail(`${at}: id must be a string.`);
      // The same id again replaces what it made before.
      const group = (spec.id as string | undefined) ?? freshGroup(state, op);
      const previous = state.snapshot.shapes.filter((shape) => shape.data.group === group).map((shape) => shape.id);
      if (previous.length > 0) deleteElements(state, previous, at);
      const before = state.created.length;
      // Sized for a slide before layout, so nodes are measured with the text they will hold.
      const onSlide = typeof spec.in === "string" && stored(state, spec.in).data.slide === true;
      if (op === "diagram") {
        const { id: _id, ...given } = spec;
        const style = (given.style ?? {}) as Record<string, unknown>;
        const diagram = onSlide && style.fontSize === undefined ? { ...given, style: { ...style, fontSize: 28 } } : given;
        const laid = layoutDiagram(diagram, context);
        for (const element of laid.elements) addElement(state, element, `${at} (${String(element.id ?? element.type)})`);
        separateLabels(state, state.created.slice(before));
        placed[group] = laid.bounds;
      } else {
        const laid = layoutChart({ ...(onSlide ? { fontSize: 26 } : {}), ...spec, id: group }, context);
        for (const element of laid.elements) addElement(state, element, `${at} (${String(element.id)})`);
        placed[group] = laid.bounds;
      }
      for (const id of state.created.slice(before)) stored(state, id).data.group = group;
      // A chart is dozens of parts; its id prefix names them all.
      if (op === "chart") state.created.splice(before, Infinity, `${group}-* (${state.created.length - before} elements)`);
    } else fail(`${at}: op must be add, update, delete, front, back, align, distribute, diagram or chart.`);
  });
  return {
    snapshot: copy,
    result: { created: state.created, ...checkLayout(state), ...(Object.keys(placed).length ? { placed } : {}) },
  };
}

/** Drawn as a line rather than an area, so nothing can overlap it in a way that matters. */
function isStroke(shape: SceneShape) {
  return shape.type === "line" || (shape.type === "geo" && geoStyle(shape.data).kind === "path" && shape.data.closed === false);
}

/** Where a line's label is drawn, as a world rect. */
function labelRect(state: EditState, shape: SceneShape, lookup: (id: string) => SceneShape | undefined, t: number) {
  const label = typeof shape.data.text === "string" ? shape.data.text : "";
  if (!label) return null;
  const layout = measureText(state, label, lineStyle(shape.data).fontSize, 240);
  const at = lineLabelCenter(resolveLine(shape.data, lookup, 0.5).points, t, layout);
  return { x: at.x - layout.width / 2 - 4, y: at.y - layout.height / 2 - 2, width: layout.width + 8, height: layout.height + 4 };
}

/** Slides each new label along its edge until it clears the nodes and the other labels. */
function separateLabels(state: EditState, ids: readonly string[]) {
  const { shapes, byId } = scene(state);
  const lookup = (id: string) => byId.get(id);
  const created = new Set(ids);
  const taken: Rect[] = shapes
    .filter((shape) => created.has(shape.id) && shape.type !== "line")
    .map((shape) => shapeBounds(shape, lookup));
  for (const shape of shapes) {
    if (!created.has(shape.id) || shape.type !== "line" || !shape.data.text) continue;
    const spot = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85]
      .map((t) => ({ t, rect: labelRect(state, shape, lookup, t) }))
      .find(({ rect }) => rect && !taken.some((other) => overlap(rect, other)));
    if (!spot?.rect) continue;
    taken.push(spot.rect);
    if (spot.t !== 0.5) stored(state, shape.id).data.labelAt = spot.t;
  }
}

/**
 * Where a text box's text actually is: its box can be wider than one short line,
 * and an overlap there is empty space, not a collision.
 */
function inkBounds(state: EditState, shape: SceneShape, bounds: Rect): Rect {
  if (shape.type !== "geo" || agentType(shape) !== "text") return bounds;
  const style = geoStyle(shape.data);
  const box = geoLabelBox(style, shape.frame);
  const text = typeof shape.data.text === "string" ? shape.data.text : "";
  const layout = geoText(state, text, style, box.width);
  const slack = Math.max(0, box.width - layout.width);
  const x = box.x + (style.align === "center" ? slack / 2 : style.align === "end" ? slack : 0);
  return { x: shape.frame.x + x, y: shape.frame.y + box.y, width: layout.width, height: Math.min(box.height, layout.height) };
}

/** Problems a model cannot see in coordinates: overflowing text, collisions, strays. */
function checkLayout(state: EditState) {
  const { shapes, byId } = scene(state);
  const lookup = (id: string) => byId.get(id);
  const parents = parentFrames(shapes);
  const warnings: string[] = [];
  const frames: CanvasEditResult["frames"] = {};
  const touched = shapes.filter((shape) => state.touched.has(shape.id));
  const ink = new Map(shapes.map((shape) => [shape.id, inkBounds(state, shape, shapeBounds(shape, lookup))]));
  for (const shape of touched) {
    const bounds = shapeBounds(shape, lookup);
    const parent = byId.get(parents.get(shape.id) ?? "");
    if (parent) frames[parent.id] = roundRect(parent.frame);
    if (shape.type === "section") frames[shape.id] = roundRect(shape.frame);
    if (shape.type === "geo" && typeof shape.data.text === "string" && shape.data.text.trim()) {
      const style = geoStyle(shape.data);
      const box = geoLabelBox(style, shape.frame);
      const layout = geoText(state, shape.data.text, style, box.width);
      if (layout.height > box.height + 1) {
        const extra = Math.ceil(layout.height - box.height);
        warnings.push(`${shape.id}: text needs ${extra}px more height than the ${style.kind === "rect" ? "box" : style.kind} gives it; raise h by ${extra} or lower fontSize.`);
      }
      if (layout.width > box.width + 1) warnings.push(`${shape.id}: a word is wider than the box; raise w or lower fontSize.`);
    }
    if (shape.type === "line") {
      const { points } = resolveLine(shape.data, lookup, 0.5);
      const length = points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - points[i].x, point.y - points[i].y), 0);
      if (length < 12) warnings.push(`${shape.id}: the line is ${Math.round(length)}px long, so its ends overlap; move what it joins apart.`);
      const mine = labelRect(state, shape, lookup, lineStyle(shape.data).labelAt);
      const covered = mine && shapes.find((other) => !isStroke(other) && other.type !== "section" && overlap(mine, inkBounds(state, other, shapeBounds(other, lookup))));
      if (covered) {
        warnings.push(`${shape.id}'s label overlaps ${covered.id}; move the shapes apart, shorten the label or set labelAt.`);
      }
      for (const other of shapes) {
        if (other.id === shape.id || other.type !== "line" || (state.touched.has(other.id) && other.id < shape.id)) continue;
        const theirs = labelRect(state, other, lookup, lineStyle(other.data).labelAt);
        if (mine && theirs && overlap(mine, theirs)) warnings.push(`${shape.id}'s label overlaps ${other.id}'s; set labelAt (0–1 along the line) on one of them.`);
      }
      continue;
    }
    // A shape outside the frame it was put in, or sticking out of the one it mostly sits in.
    const intended = byId.get(state.placed.get(shape.id) ?? "");
    const host =
      intended ??
      shapes.find(
        (frame) => frame.type === "section" && frame.id !== shape.id && (overlap(frame.frame, bounds)?.width ?? 0) * (overlap(frame.frame, bounds)?.height ?? 0) > (bounds.width * bounds.height) / 2,
      );
    if (host && !contains(host.frame, bounds)) {
      const local = { x: bounds.x - host.frame.x, y: bounds.y - host.frame.y };
      warnings.push(
        `${shape.id}: reaches x ${Math.round(local.x)}…${Math.round(local.x + bounds.width)}, y ${Math.round(local.y)}…${Math.round(local.y + bounds.height)} in ${host.id}, outside its ${Math.round(host.frame.width)}×${Math.round(host.frame.height)}.`,
      );
    }
    // Overlaps with siblings, unless one wholly holds the other (a card's background).
    const mine = ink.get(shape.id) ?? bounds;
    if (isStroke(shape)) continue;
    for (const other of shapes) {
      if (other.id === shape.id || isStroke(other) || other.type === "section" || shape.type === "section") continue;
      if (parents.get(other.id) !== parents.get(shape.id)) continue;
      if (state.touched.has(other.id) && other.id < shape.id) continue;
      const theirs = ink.get(other.id) ?? shapeBounds(other, lookup);
      const hit = overlap(mine, theirs);
      if (!hit || hit.width < 4 || hit.height < 4) continue;
      if (contains(shapeBounds(shape, lookup), theirs) || contains(shapeBounds(other, lookup), mine)) continue;
      warnings.push(`${shape.id} overlaps ${other.id} by ${Math.round(hit.width)}×${Math.round(hit.height)}px.`);
    }
  }
  return { warnings, frames };
}

export { CanvasEditError };
