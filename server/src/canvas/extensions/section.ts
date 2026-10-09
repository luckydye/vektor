import { drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import { drawText } from "#canvas/render/text.ts";
import { type CanvasGpu, parseColor, type Rgba } from "#canvas/render/webgl.ts";
import { CanvasElementBase } from "#canvas/runtime/elementBase.ts";
import type {
  CanvasHitTestHelpers,
  CanvasPaintHelpers,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import { pointOnRotatedShape, rotateVector } from "#canvas/runtime/geometry.ts";
import { iconMarkup } from "#components/Icon.tsx";

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

// Draws the section frame and, unless it is being edited, its title chrome.
// Screen-space geometry (transform, title position/size) comes from the host so
// hit-testing and the inline title editor stay in sync with what is painted.
function paintSection(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const { scale, dx, dy } = helpers;
  const frame = shape.frame;
  const width = frame.width * scale;
  const height = frame.height * scale;
  if (width <= 0 || height <= 0) return;

  const color = parseColor(shape.style.color);
  const fade = (alpha: number): Rgba => [color[0], color[1], color[2], color[3] * alpha];
  const rotation = (frame.rotation * Math.PI) / 180;
  drawRoundedRect(
    gpu,
    rectQuad(frame.x * scale + dx, frame.y * scale + dy, width, height, rotation),
    {
      radius: 10 * scale,
      fill: fade(0.09),
      stroke: fade(0.6),
      strokeWidth: 2 * scale,
    },
  );

  if (helpers.isEditingChrome(shape.id)) return;

  const position = helpers.chromePosition(shape);
  const size = helpers.chromeSize(shape);
  const title =
    (typeof shape.data.text === "string" && shape.data.text) || helpers.t("Section");
  // `chromePosition` is the chip's top-left corner, which it rotates about.
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const chip = {
    origin: position,
    axisX: { x: cos * size.width, y: sin * size.width },
    axisY: { x: -sin * size.height, y: cos * size.height },
  };
  drawRoundedRect(gpu, chip, {
    radius: 6,
    fill: fade(0.1),
    stroke: fade(0.48),
    strokeWidth: 1,
  });
  const middle = size.height / 2;
  drawText(gpu, title, {
    at: {
      x: position.x + 8 * cos - middle * sin,
      y: position.y + 8 * sin + middle * cos,
    },
    rotation,
    size: 13,
    color: parseColor(helpers.chromeTextColor),
    maxWidth: Math.max(0, size.width - 16),
    clip: { x: -8, y: -middle, width: size.width, height: size.height },
    invalidate: helpers.invalidate,
  });
}

// Section frame accent colors offered by the toolbar swatch.
const SECTION_COLORS = ["#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#a78bfa"] as const;

// Sections are drawn entirely on a dedicated canvas layer (frame + title) and
// only expose a resize handle — they never rotate and have no DOM body.
export const CanvasSection = CanvasElement.create({
  name: "section",

  addOptions() {
    return {
      colors: SECTION_COLORS as readonly string[],
      size: { width: 560, height: 340 },
      minSize: { width: 240, height: 160 },
      title: "Section",
    };
  },

  addDefaults() {
    return {
      size: this.options.size,
      minSize: this.options.minSize,
      style: { color: this.options.colors[0] },
      data: { text: this.options.title },
    };
  },

  addCreation() {
    const { colors, size, title } = this.options;
    return {
      palette: colors,
      tool: {
        id: this.name,
        label: "Section" as const,
        shortcut: "S",
        icon: iconMarkup("frame-section-tool"),
      },
      editOnCreate: "chrome" as const,
      create: (at: { x: number; y: number }, ctx: { color?: string }) =>
        createSectionShape(at, ctx.color ?? colors[0], size, title),
    };
  },

  addRender() {
    return {
      surface: "canvas" as const,
      paint: paintSection,
      hitTest: (shape, world, helpers) => hitTestSection(shape, world, helpers),
      chrome: {
        editorTag: "canvas-section-title-editor",
        position: (shape, helpers) => {
          const gap = 32 / helpers.scale;
          return helpers.worldToScreen(
            pointOnRotatedShape(shape.frame, { x: 0, y: -gap }),
          );
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
    };
  },

  addBehavior() {
    return {
      transform: { move: true, resize: "box" as const, rotate: false },
      // Behind everything else: a section frames content rather than covering it.
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
    };
  },
});

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

const sectionEditorTag = CanvasSection.render.chrome?.editorTag;
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

function createSectionShape(
  at: { x: number; y: number },
  color: string = SECTION_COLORS[0],
  size: { width: number; height: number } = { width: 560, height: 340 },
  title = "Section",
): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "section",
    frame: {
      x: Math.round(at.x),
      y: Math.round(at.y),
      width: size.width,
      height: size.height,
      rotation: 0,
    },
    style: { color },
    data: { text: title },
    updatedAt: Date.now(),
  };
}
