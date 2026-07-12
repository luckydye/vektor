import { canvasSectionIcon } from "#assets/icons.ts";
import { rotateVector } from "#canvas/geometry.ts";
import type {
  CanvasElementExtension,
  CanvasHitTestHelpers,
  CanvasPaintHelpers,
  CanvasShape,
} from "./types.ts";

// Sections are click-through in their interior; only the painted border (this
// many world px) is grabbable, preserving access to content placed inside.
const SECTION_BORDER = 6;

function sectionLocalPoint(world: { x: number; y: number }, shape: CanvasShape) {
  const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 };
  const local = rotateVector(
    { x: world.x - center.x, y: world.y - center.y },
    -shape.rotation,
  );
  return { x: local.x + shape.width / 2, y: local.y + shape.height / 2 };
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const cornerRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + cornerRadius, y);
  context.arcTo(x + width, y, x + width, y + height, cornerRadius);
  context.arcTo(x + width, y + height, x, y + height, cornerRadius);
  context.arcTo(x, y + height, x, y, cornerRadius);
  context.arcTo(x, y, x + width, y, cornerRadius);
  context.closePath();
}

// Draws the section frame and, unless it is being edited, its title chrome.
// Screen-space geometry (transform, title position/size) comes from the host so
// hit-testing and the inline title editor stay in sync with what is painted.
function paintSection(
  context: CanvasRenderingContext2D,
  shape: CanvasShape,
  helpers: CanvasPaintHelpers,
) {
  const { scale, dx, dy } = helpers;
  const width = shape.width * scale;
  const height = shape.height * scale;
  if (width <= 0 || height <= 0) return;

  const centerX = (shape.x + shape.width / 2) * scale + dx;
  const centerY = (shape.y + shape.height / 2) * scale + dy;
  context.save();
  context.translate(centerX, centerY);
  context.rotate((shape.rotation * Math.PI) / 180);
  roundedRectPath(context, -width / 2, -height / 2, width, height, 10 * scale);
  context.fillStyle = shape.color;
  context.globalAlpha = 0.09;
  context.fill();
  context.strokeStyle = shape.color;
  context.globalAlpha = 0.6;
  context.lineWidth = 2 * scale;
  context.stroke();
  context.restore();

  if (helpers.isEditingSectionTitle(shape.id)) return;

  const position = helpers.sectionTitlePosition(shape);
  const size = helpers.sectionTitleSize(shape);
  const title = shape.text || helpers.t("Section");

  context.save();
  context.translate(position.x, position.y);
  context.rotate((shape.rotation * Math.PI) / 180);
  roundedRectPath(context, 0, 0, size.width, size.height, 6);
  context.fillStyle = shape.color;
  context.globalAlpha = 0.1;
  context.fill();
  context.strokeStyle = shape.color;
  context.globalAlpha = 0.48;
  context.lineWidth = 1;
  context.stroke();

  context.save();
  roundedRectPath(context, 0, 0, size.width, size.height, 6);
  context.clip();
  context.globalAlpha = 1;
  context.fillStyle = helpers.sectionTitleColor;
  context.font = "750 13px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.fillText(title, 8, size.height / 2, Math.max(0, size.width - 16));
  context.restore();
  context.restore();
}

// Section frame accent colors offered by the toolbar swatch.
export const SECTION_COLORS = [
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
] as const;

// Sections are drawn entirely on a dedicated canvas layer (frame + title) and
// only expose a resize handle — they never rotate and have no DOM body.
export const sectionElement: CanvasElementExtension = {
  type: "section",
  defaultText: "Section",
  defaultColor: SECTION_COLORS[0],
  defaultSize: { width: 560, height: 340 },
  minSize: { width: 240, height: 160 },
  surface: "canvas",
  transform: { move: true, resize: "box", rotate: false },
  palette: SECTION_COLORS,
  tool: { id: "section", label: "Section", shortcut: "S", icon: canvasSectionIcon },
  create: (at, ctx) => createSectionShape(at, ctx.color ?? sectionElement.defaultColor),
  paint: paintSection,
  hitTest: (shape, world, helpers) => hitTestSection(shape, world, helpers),
};

// The title (screen-space box above the frame) takes priority over the border
// (world-space edge band); the interior is click-through (null).
function hitTestSection(
  shape: CanvasShape,
  world: { x: number; y: number },
  helpers: CanvasHitTestHelpers,
): "title" | "border" | null {
  const screen = helpers.worldToScreen(world);
  const origin = helpers.sectionTitlePosition(shape);
  const titleLocal = rotateVector(
    { x: screen.x - origin.x, y: screen.y - origin.y },
    -shape.rotation,
  );
  const size = helpers.sectionTitleSize(shape);
  if (
    titleLocal.x >= 0 &&
    titleLocal.x <= size.width &&
    titleLocal.y >= 0 &&
    titleLocal.y <= size.height
  ) {
    return "title";
  }

  const local = sectionLocalPoint(world, shape);
  const inBounds =
    local.x >= -SECTION_BORDER &&
    local.x <= shape.width + SECTION_BORDER &&
    local.y >= -SECTION_BORDER &&
    local.y <= shape.height + SECTION_BORDER;
  const onEdge =
    local.x <= SECTION_BORDER ||
    local.x >= shape.width - SECTION_BORDER ||
    local.y <= SECTION_BORDER ||
    local.y >= shape.height - SECTION_BORDER;
  return inBounds && onEdge ? "border" : null;
}

export function createSectionShape(
  at: { x: number; y: number },
  color = sectionElement.defaultColor,
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "section",
    x: Math.round(at.x),
    y: Math.round(at.y),
    width: sectionElement.defaultSize.width,
    height: sectionElement.defaultSize.height,
    rotation: 0,
    text: sectionElement.defaultText,
    color,
    updatedAt: Date.now(),
  };
}
