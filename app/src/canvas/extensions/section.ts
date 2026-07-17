import { frameSectionToolIcon } from "#assets/icons.ts";
import { pointOnRotatedShape, rotateVector } from "#canvas/viewport/geometry.ts";
import { CanvasElementBase } from "./CanvasElementBase.ts";
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
  const frame = shape.frame;
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const local = rotateVector(
    { x: world.x - center.x, y: world.y - center.y },
    -frame.rotation,
  );
  return { x: local.x + frame.width / 2, y: local.y + frame.height / 2 };
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
  const frame = shape.frame;
  const width = frame.width * scale;
  const height = frame.height * scale;
  if (width <= 0 || height <= 0) return;

  const centerX = (frame.x + frame.width / 2) * scale + dx;
  const centerY = (frame.y + frame.height / 2) * scale + dy;
  context.save();
  context.translate(centerX, centerY);
  context.rotate((frame.rotation * Math.PI) / 180);
  roundedRectPath(context, -width / 2, -height / 2, width, height, 10 * scale);
  context.fillStyle = shape.style.color;
  context.globalAlpha = 0.09;
  context.fill();
  context.strokeStyle = shape.style.color;
  context.globalAlpha = 0.6;
  context.lineWidth = 2 * scale;
  context.stroke();
  context.restore();

  if (helpers.isEditingChrome(shape.id)) return;

  const position = helpers.chromePosition(shape);
  const size = helpers.chromeSize(shape);
  const title =
    (typeof shape.data.text === "string" && shape.data.text) || helpers.t("Section");

  context.save();
  context.translate(position.x, position.y);
  context.rotate((frame.rotation * Math.PI) / 180);
  roundedRectPath(context, 0, 0, size.width, size.height, 6);
  context.fillStyle = shape.style.color;
  context.globalAlpha = 0.1;
  context.fill();
  context.strokeStyle = shape.style.color;
  context.globalAlpha = 0.48;
  context.lineWidth = 1;
  context.stroke();

  context.save();
  roundedRectPath(context, 0, 0, size.width, size.height, 6);
  context.clip();
  context.globalAlpha = 1;
  context.fillStyle = helpers.chromeTextColor;
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
  defaults: {
    size: { width: 560, height: 340 },
    minSize: { width: 240, height: 160 },
    style: { color: SECTION_COLORS[0] },
    data: { text: "Section" },
  },
  creation: {
    palette: SECTION_COLORS,
    tool: { id: "section", label: "Section", shortcut: "S", icon: frameSectionToolIcon },
    editOnCreate: "chrome",
    create: (at, ctx) =>
      createSectionShape(at, ctx.color ?? sectionElement.defaults.style.color),
  },
  render: {
    surface: "canvas",
    paint: paintSection,
    hitTest: (shape, world, helpers) => hitTestSection(shape, world, helpers),
    chrome: {
      editorTag: "canvas-section-title-editor",
      position: (shape, helpers) => {
        const gap = 32 / helpers.scale;
        return helpers.worldToScreen(pointOnRotatedShape(shape.frame, { x: 0, y: -gap }));
      },
      size: (shape, helpers) => {
        const maxWidth = Math.max(1, shape.frame.width * helpers.scale);
        const title =
          (typeof shape.data.text === "string" && shape.data.text) ||
          helpers.t("Section");
        return {
          width: Math.min(maxWidth, Math.max(40, title.length * 8 + 16)),
          height: 22,
        };
      },
    },
  },
  behavior: {
    transform: { move: true, resize: "box", rotate: false },
    zOrder: -1,
    container: {
      containsBounds: (section, bounds) =>
        bounds.x >= section.frame.x &&
        bounds.y >= section.frame.y &&
        bounds.x + bounds.width <= section.frame.x + section.frame.width &&
        bounds.y + bounds.height <= section.frame.y + section.frame.height,
      containsPoint: (section, point) =>
        point.x >= section.frame.x &&
        point.y >= section.frame.y &&
        point.x <= section.frame.x + section.frame.width &&
        point.y <= section.frame.y + section.frame.height,
    },
  },
};

class CanvasSectionTitleEditor extends CanvasElementBase {
  private input: HTMLInputElement | null = null;

  protected mount() {
    const input = document.createElement("input");
    input.className = "canvas-section-title";
    input.spellcheck = false;
    input.addEventListener("focus", () => {
      const shape = this.shapeData;
      if (shape) this.services?.selectShape(shape.id);
    });
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
    input.addEventListener("input", () => {
      const shape = this.shapeData;
      if (shape) this.services?.updateData(shape.id, { text: input.value });
    });
    input.addEventListener("blur", () => {
      this.dispatchEvent(new CustomEvent("finish-edit", { bubbles: true }));
    });
    this.appendChild(input);
    this.input = input;
  }

  protected update() {
    const shape = this.shapeData;
    if (!shape || !this.input) return;
    this.input.setAttribute("aria-label", this.services?.t("Section headline") ?? "");
    if (this.input !== document.activeElement) {
      this.input.value = typeof shape.data.text === "string" ? shape.data.text : "";
    }
  }

  focus(options?: FocusOptions) {
    this.input?.focus(options);
    this.input?.select();
  }
}

const sectionEditorTag = sectionElement.render.chrome?.editorTag;
if (
  typeof customElements !== "undefined" &&
  sectionEditorTag &&
  !customElements.get(sectionEditorTag)
) {
  customElements.define(sectionEditorTag, CanvasSectionTitleEditor);
}

// The title (screen-space box above the frame) takes priority over the border
// (world-space edge band); the interior is click-through (null).
function hitTestSection(
  shape: CanvasShape,
  world: { x: number; y: number },
  helpers: CanvasHitTestHelpers,
): "title" | "border" | null {
  const screen = helpers.worldToScreen(world);
  const origin = helpers.chromePosition(shape);
  const titleLocal = rotateVector(
    { x: screen.x - origin.x, y: screen.y - origin.y },
    -shape.frame.rotation,
  );
  const size = helpers.chromeSize(shape);
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
    local.x <= shape.frame.width + SECTION_BORDER &&
    local.y >= -SECTION_BORDER &&
    local.y <= shape.frame.height + SECTION_BORDER;
  const onEdge =
    local.x <= SECTION_BORDER ||
    local.x >= shape.frame.width - SECTION_BORDER ||
    local.y <= SECTION_BORDER ||
    local.y >= shape.frame.height - SECTION_BORDER;
  return inBounds && onEdge ? "border" : null;
}

export function createSectionShape(
  at: { x: number; y: number },
  color = sectionElement.defaults.style.color,
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "section",
    frame: {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: sectionElement.defaults.size.width,
      height: sectionElement.defaults.size.height,
      rotation: 0,
    },
    style: { color },
    data: { ...sectionElement.defaults.data },
    updatedAt: Date.now(),
  };
}
