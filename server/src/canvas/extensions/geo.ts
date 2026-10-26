import { editorTheme, shapePlacement, shapeTextLayout } from "#canvas/extensions/shapePaint.ts";
import { fillPath } from "#canvas/render/paths.ts";
import {
  contrastText,
  dashPattern,
  GEO_PARAGRAPH_GAP,
  type GeoKind,
  geoLabelBox,
  geoOutline,
  geoStyle,
  nodesToWorld,
} from "#canvas/render/shapeGeometry.ts";
import { drawTextLayout } from "#canvas/render/text.ts";
import { distanceToSegment, flattenPath, pointInPolygon, strokePath } from "#canvas/render/vector.ts";
import { type CanvasGpu, parseColor } from "#canvas/render/webgl.ts";
import { CanvasRichTextElement } from "#canvas/runtime/elementBase.ts";
import type {
  CanvasClientPoint,
  CanvasEditSession,
  CanvasHitTestHelpers,
  CanvasPaintHelpers,
  CanvasPoint,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { shared } from "#canvas/runtime/state.ts";
import { iconMarkup } from "#components/Icon.tsx";
import { beginPointEdit } from "#canvas/extensions/pointEdit.ts";
import type { TranslationKey } from "#utils/lang.ts";

/** Screen pixels within which a press on an unfilled outline still counts. */
const HIT_SLOP = 6;

/** A rotated outline, fill and label from data: the vector shape primitive. */
function outlineWorld(shape: CanvasShape, tolerance: number) {
  const style = geoStyle(shape.data);
  const outline = geoOutline(style.kind, shape.frame, shape.data);
  const flat = (nodes: Parameters<typeof nodesToWorld>[1], closed: boolean) =>
    flattenPath(nodesToWorld(shape.frame, nodes), closed, tolerance);
  return {
    style,
    body: { points: flat(outline.nodes, outline.closed), closed: outline.closed },
    details: outline.details.map((detail) => ({
      points: flat(detail.nodes, detail.closed),
      closed: detail.closed,
    })),
  };
}

function paintGeo(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const tolerance = 0.25 / helpers.scale;
  const { style, body, details } = outlineWorld(shape, tolerance);
  const fill = shape.style.color;
  if (body.closed && fill !== "transparent") {
    fillPath(gpu, { rings: [body.points], rule: "nonzero" }, parseColor(fill));
  }
  if (style.strokeWidth > 0 && style.stroke !== "transparent") {
    fillPath(
      gpu,
      strokePath([body, ...details], {
        width: style.strokeWidth,
        join: style.kind === "ellipse" ? "round" : "miter",
        pattern: dashPattern(style.dash, style.strokeWidth),
        tolerance,
      }),
      parseColor(style.stroke),
    );
  }
  if (helpers.editing(shape.id)) return;
  const layout = labelLayout(shape, helpers.color("--canvas-text"), helpers.invalidate);
  if (!layout) return;
  drawTextLayout(gpu, layout.text, shapePlacement(shape, helpers, layout.at));
}

function labelColor(shape: CanvasShape, themeText: string) {
  const { textColor } = geoStyle(shape.data);
  return textColor || contrastText(shape.style.color, themeText);
}

function labelLayout(shape: CanvasShape, themeText: string, invalidate: () => void) {
  if (typeof shape.data.text !== "string" || !shape.data.text.trim()) return null;
  const style = geoStyle(shape.data);
  const box = geoLabelBox(style, shape.frame);
  const theme = {
    ...editorTheme(style.fontSize, labelColor(shape, themeText)),
    align: style.align,
    paragraphGap: GEO_PARAGRAPH_GAP,
  };
  const text = shapeTextLayout(shape, theme, box.width, invalidate);
  if (!text) return null;
  const free = box.height - text.height;
  const y =
    style.valign === "top" ? box.y : style.valign === "bottom" ? box.y + free : box.y + free / 2;
  return { text, at: { x: box.x, y } };
}

function hitTestGeo(shape: CanvasShape, world: CanvasPoint, helpers: CanvasHitTestHelpers) {
  const screenTolerance = helpers.worldToScreen({ x: 1, y: 0 }).x - helpers.worldToScreen({ x: 0, y: 0 }).x;
  const tolerance = 0.5 / Math.max(screenTolerance, 1e-6);
  const { style, body } = outlineWorld(shape, tolerance);
  if (body.closed && pointInPolygon(world, body.points)) return "body";
  const screen = helpers.worldToScreen(world);
  const slop = HIT_SLOP + (style.strokeWidth * screenTolerance) / 2;
  const points = body.points.map(helpers.worldToScreen);
  const count = body.closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    if (distanceToSegment(screen, points[i], points[(i + 1) % points.length]) <= slop) {
      return "body";
    }
  }
  return null;
}

function geoEditor(shape: CanvasShape, at: CanvasClientPoint | null): CanvasEditSession {
  return { shapeId: shape.id, tag: "canvas-geo", props: { caret: at } };
}

/** One placeable entry in the toolbar's shape picker. */
export type CanvasShapeLibraryItem = {
  id: GeoKind;
  label: TranslationKey;
  icon: string;
};

export const SHAPE_LIBRARY: CanvasShapeLibraryItem[] = [
  { id: "rect", label: "Rectangle", icon: iconMarkup("shape-rectangle") },
  { id: "ellipse", label: "Circle", icon: iconMarkup("shape-circle") },
  { id: "diamond", label: "Diamond", icon: iconMarkup("shape-diamond") },
  { id: "triangle", label: "Triangle", icon: iconMarkup("shape-triangle") },
];

// Which kind the shape tool draws next; the toolbar picker sets it.
export const activeShapeId = shared<GeoKind>("rect");
export function setActiveShapeId(id: GeoKind) {
  activeShapeId.set(id);
}

const GEO_COLORS = [
  "#ffffff",
  "#dbeafe",
  "#dcfce7",
  "#fef3c7",
  "#fee2e2",
  "#ede9fe",
  "transparent",
] as const;

export const STROKE_COLORS = [
  "#334155",
  "#111827",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#dc2626",
  "#7c3aed",
  "transparent",
] as const;

export const CanvasGeo = CanvasElement.create({
  name: "geo",

  addOptions() {
    return {
      colors: GEO_COLORS as readonly string[],
      size: { width: 200, height: 120 },
      minSize: { width: 4, height: 4 },
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: this.options.colors[0] },
      data: { kind: "rect", text: "" },
    };
  },

  addCreation() {
    const { colors, size } = this.options;
    return {
      palette: colors,
      tool: {
        id: "shape",
        label: "Shape" as const,
        shortcut: "S",
        icon: iconMarkup("shapes-tool"),
        button: false as const,
      },
      dragToSize: true,
      create: (at: CanvasPoint, ctx: { color?: string }): CanvasShape => {
        const kind = activeShapeId.get();
        const square = kind === "ellipse" || kind === "diamond" || kind === "triangle";
        return {
          id: `shape-${crypto.randomUUID()}`,
          type: "geo",
          frame: {
            x: Math.round(at.x),
            y: Math.round(at.y),
            width: square ? size.height : size.width,
            height: size.height,
            rotation: 0,
          },
          style: { color: ctx.color ?? colors[0] },
          data: { kind, text: "" },
          updatedAt: Date.now(),
        };
      },
    };
  },

  addRender() {
    return {
      paint: paintGeo,
      hitTest: hitTestGeo,
      cursor: () => "move",
      editor: geoEditor,
      editorOverlay: true,
      article: {
        background: false,
        style: (shape: CanvasShape) => {
          const style = geoStyle(shape.data);
          const box = geoLabelBox(style, shape.frame);
          return {
            "--canvas-geo-font-size": `${style.fontSize}px`,
            "--canvas-geo-color": labelColor(shape, "var(--canvas-text)"),
            "--canvas-geo-align": style.align,
            "--canvas-geo-valign":
              style.valign === "top" ? "flex-start" : style.valign === "bottom" ? "flex-end" : "center",
            "--canvas-geo-inset": `${box.y}px ${shape.frame.width - box.x - box.width}px ${
              shape.frame.height - box.y - box.height
            }px ${box.x}px`,
          };
        },
      },
    };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: true, handles: "edges" as const },
    };
  },

  addEvents() {
    return {
      doubleClick: (shape, host) => host.beginEdit(geoEditor(shape, null)),
    };
  },

  addProperties() {
    return [
      {
        kind: "select",
        id: "kind",
        label: "Shape",
        options: [
          { value: "rect", label: "Rectangle" },
          { value: "ellipse", label: "Ellipse" },
          { value: "diamond", label: "Diamond" },
          { value: "triangle", label: "Triangle" },
          { value: "hexagon", label: "Hexagon" },
          { value: "parallelogram", label: "Parallelogram" },
          { value: "star", label: "Star" },
          { value: "cylinder", label: "Cylinder" },
        ],
        default: "rect",
      },
      { kind: "swatches", id: "stroke", label: "Outline", options: STROKE_COLORS, default: "#334155" },
      {
        kind: "select",
        id: "strokeWidth",
        label: "Outline width",
        options: [
          { value: 0, label: "None" },
          { value: 1, label: "Thin" },
          { value: 2, label: "Medium" },
          { value: 4, label: "Thick" },
        ],
        default: 2,
      },
      {
        kind: "select",
        id: "dash",
        label: "Outline style",
        options: [
          { value: "solid", label: "Solid" },
          { value: "dashed", label: "Dashed" },
          { value: "dotted", label: "Dotted" },
        ],
        default: "solid",
      },
      {
        kind: "select",
        id: "fontSize",
        label: "Text size",
        options: [
          { value: 14, label: "Small" },
          { value: 18, label: "Medium" },
          { value: 24, label: "Large" },
          { value: 36, label: "Extra large" },
        ],
        default: 18,
      },
    ] as const;
  },

  contextMenu(shape, host) {
    return [
      {
        id: "edit-points",
        label: "Edit points",
        icon: iconMarkup("edit-points"),
        run: () => beginPointEdit(shape, host),
      },
    ];
  },
});


// The label editor, mounted only while editing over the painted shape.
class CanvasGeoElement extends CanvasRichTextElement {
  protected readonly showHandle = false;
  protected readonly removeWhenEmpty = false;
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-geo")) {
  customElements.define("canvas-geo", CanvasGeoElement);
}
