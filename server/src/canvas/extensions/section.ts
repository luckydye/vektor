import { drawRoundedRect, rectQuad } from "#canvas/render/primitives.ts";
import {
  drawTextField,
  drawTextLayout,
  lineLayout,
  middlePlacement,
} from "#canvas/render/text.ts";
import type { TextStyle } from "#canvas/render/textLayout.ts";
import { type CanvasGpu, parseColor, type Rgba } from "#canvas/render/webgl.ts";
import type {
  CanvasHitTestHelpers,
  CanvasPaintHelpers,
  CanvasShape,
} from "#canvas/runtime/extensionApi.ts";
import { CanvasElement } from "#canvas/runtime/extensionApi.ts";
import {
  localPointInShape,
  pointOnRotatedShape,
  rotateVector,
} from "#canvas/runtime/geometry.ts";
import { iconMarkup } from "#components/Icon.tsx";
import type { TranslationKey } from "#utils/lang.ts";

// Sections are click-through in their interior; only the painted border (this
// many world px) is grabbable, preserving access to content placed inside.
const SECTION_BORDER = 6;

// Draws the section frame and, unless it is being edited, its title row.
// Screen-space geometry (transform, title position/size) comes from the host so
// hit-testing and the inline title editor stay in sync with what is painted.
// Sections never rotate, so everything here is axis-aligned.
function paintSection(gpu: CanvasGpu, shape: CanvasShape, helpers: CanvasPaintHelpers) {
  const { scale, dx, dy, dpr } = helpers;
  const frame = shape.frame;
  if (frame.width <= 0 || frame.height <= 0) return;

  // A one-pixel border lands on device pixels at any zoom: an odd device width
  // is centred on a pixel, an even one on a pixel edge.
  const half = (Math.round(dpr) % 2) / (2 * dpr);
  const snap = (value: number) => Math.round(value * dpr) / dpr + half;
  const left = snap(frame.x * scale + dx);
  const top = snap(frame.y * scale + dy);
  // A transparent frame keeps a neutral border so it can still be found.
  const transparent = shape.style.color === "transparent";
  const color = parseColor(
    transparent ? helpers.color("--canvas-frame-border") : shape.style.color,
  );
  const fade = (alpha: number): Rgba => [color[0], color[1], color[2], color[3] * alpha];
  drawRoundedRect(
    gpu,
    rectQuad(
      left,
      top,
      snap((frame.x + frame.width) * scale + dx) - left,
      snap((frame.y + frame.height) * scale + dy) - top,
    ),
    { fill: fade(transparent ? 0 : 0.06), stroke: fade(0.9), strokeWidth: 1 },
  );

  if (!helpers.chrome) return;

  const position = helpers.chromePosition(shape);
  const size = helpers.chromeSize(shape);
  const middle = position.y + size.height / 2;
  const title =
    (typeof shape.data.text === "string" && shape.data.text) || helpers.t("Section");
  const edit = helpers.textEdit(shape.id);
  const style = titleStyle(helpers.chromeTextColor);
  if (edit?.field === "title") {
    drawTextField(gpu, edit, style, { x: position.x, y: middle }, helpers.invalidate);
  }
  const label = edit?.field === "title" ? null : lineLayout(title, style, helpers.invalidate);
  if (label) {
    drawTextLayout(gpu, label, {
      ...middlePlacement(label, { x: position.x, y: middle }, 1),
      clip: { x: 0, y: 0, width: Math.max(0, size.width - 16), height: label.height },
    });
  }

  const controls = sectionControls(
    shape,
    position,
    (frame.x + frame.width) * scale + dx,
    size.width,
    helpers.t,
  );
  if (!controls) return;
  const hovered = helpers.hoveredRegion(shape.id);
  if (hovered === "size") {
    drawRoundedRect(
      gpu,
      rectQuad(controls.size.x - 4, position.y + 2, controls.size.width + 8, size.height - 4),
      { radius: 4, fill: parseColor(helpers.color("--canvas-divider-color")) },
    );
  }
  const readout = lineLayout(
    controls.size.label,
    controlStyle(helpers.color("--canvas-muted")),
    helpers.invalidate,
  );
  if (edit?.field === "size") {
    drawTextField(
      gpu,
      edit,
      controlStyle(helpers.chromeTextColor),
      { x: controls.size.x + controls.size.width, y: middle, align: "end" },
      helpers.invalidate,
    );
  } else if (readout) {
    drawTextLayout(gpu, readout, middlePlacement(readout, { x: controls.size.x, y: middle }, 1));
  }
  const chipStyle = controlStyle(helpers.chromeTextColor);
  for (const chip of controls.chips) {
    drawRoundedRect(gpu, rectQuad(chip.x, position.y + 2, chip.width, size.height - 4), {
      radius: (size.height - 4) / 2,
      fill: parseColor(
        helpers.color(
          hovered === chip.region ? "--canvas-divider-color" : "--canvas-toolbar-bg",
        ),
      ),
      stroke: parseColor(helpers.color("--canvas-toolbar-border")),
      strokeWidth: 1,
    });
    const text = lineLayout(chip.label, chipStyle, helpers.invalidate);
    if (!text) continue;
    drawTextLayout(gpu, text, middlePlacement(text, { x: chip.x + 8, y: middle }, 1));
  }
}

const EXPORT_SCALES = [0.5, 1, 2, 3] as const;

function exportScale(shape: CanvasShape): number {
  const value = shape.data.exportScale;
  return typeof value === "number" && value > 0 ? value : 1;
}

function controlStyle(color: string): TextStyle {
  return { face: "regular", size: 12, color };
}

function controlTextWidth(text: string): number {
  // Until the font loads, an estimate of 7px per character.
  const layout = lineLayout(text, controlStyle("#000"), () => {});
  return layout ? Math.ceil(layout.width) : text.length * 7;
}

type SectionControl = {
  region: "scale" | "export";
  label: string;
  x: number;
  width: number;
};

/**
 * The size readout and export chips, right-aligned on the title row in screen
 * px; null when they would run into the title.
 */
function sectionControls(
  shape: CanvasShape,
  row: { x: number; y: number },
  right: number,
  titleWidth: number,
  t: (key: TranslationKey) => string,
): { size: { label: string; x: number; width: number }; chips: SectionControl[] } | null {
  const chips: SectionControl[] = [];
  let x = right;
  for (const chip of [
    { region: "export" as const, label: t("Export") },
    { region: "scale" as const, label: `${exportScale(shape)}×` },
  ]) {
    const width = controlTextWidth(chip.label) + 16;
    x -= width;
    chips.unshift({ ...chip, x, width });
    x -= 6;
  }
  const label = `${Math.round(shape.frame.width)}×${Math.round(shape.frame.height)}`;
  const width = controlTextWidth(label);
  x -= width + 4;
  if (x < row.x + titleWidth + 12) return null;
  return { size: { label, x, width }, chips };
}

/** The title row's controls as the pointer sees them, in viewport px. */
function sectionControlsAt(shape: CanvasShape, helpers: CanvasHitTestHelpers) {
  const row = helpers.chromePosition(shape);
  const chrome = helpers.chromeSize(shape);
  const right = helpers.worldToScreen({
    x: shape.frame.x + shape.frame.width,
    y: shape.frame.y,
  }).x;
  const controls = sectionControls(shape, row, right, chrome.width, helpers.t);
  return controls && { ...controls, row: { ...row, height: chrome.height } };
}

/** "800x600", "800 × 600" or "800, 600" as a size; null for anything else. */
function parseSize(value: string): { width: number; height: number } | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×X*,\s]\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function titleStyle(color: string): TextStyle {
  return { face: "regular", size: 12, color };
}

// Section frame accent colors offered by the toolbar swatch.
// "transparent" comes first, so a new frame has no fill unless one is picked.
const SECTION_COLORS = [
  "transparent",
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#a78bfa",
] as const;

function sectionClips(section: CanvasShape): boolean {
  return section.data.clip === true;
}

function sectionContainsPoint(section: CanvasShape, point: { x: number; y: number }) {
  return (
    point.x >= section.frame.x &&
    point.y >= section.frame.y &&
    point.x <= section.frame.x + section.frame.width &&
    point.y <= section.frame.y + section.frame.height
  );
}

// Sections are drawn entirely on a dedicated canvas layer (frame + title) and
// only expose a resize handle — they never rotate and have no DOM body.
export const CanvasSection = CanvasElement.create({
  name: "section",

  addOptions() {
    return {
      colors: SECTION_COLORS as readonly string[],
      size: { width: 560, height: 340 },
      minSize: { width: 40, height: 40 },
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
      dragToSize: true,
      create: (at: { x: number; y: number }, ctx: { color?: string }) =>
        createSectionShape(at, ctx.color ?? colors[0], size, title),
    };
  },

  addRender() {
    return {
      paint: paintSection,
      hitTest: (shape, world, helpers) => hitTestSection(shape, world, helpers),
      cursor: (_shape, region) =>
        region === "size"
          ? "text"
          : region === "scale" || region === "export"
            ? "pointer"
            : "move",
      chrome: {
        position: (shape, helpers) => {
          const gap = 26 / helpers.scale;
          return helpers.worldToScreen(
            pointOnRotatedShape(shape.frame, { x: 0, y: -gap }),
          );
        },
        size: (shape, helpers) => {
          const maxWidth = Math.max(1, shape.frame.width * helpers.scale);
          const title =
            (typeof shape.data.text === "string" && shape.data.text) ||
            helpers.t("Section");
          // Until the font loads, an estimate of 8px per character.
          const label = lineLayout(title, titleStyle("#000"), () => {});
          const width = label ? Math.ceil(label.width) + 16 : title.length * 8 + 16;
          return { width: Math.min(maxWidth, Math.max(40, width)), height: 22 };
        },
      },
    };
  },

  addEvents() {
    return {
      editChrome: (shape, host) =>
        host.editText({
          shapeId: shape.id,
          field: "title",
          label: "Section headline",
          value: typeof shape.data.text === "string" ? shape.data.text : "",
          commit: (text) => host.updateData(shape.id, { text }),
        }),
      click: (shape, host, hit) => {
        const at = { clientX: hit.event.clientX, clientY: hit.event.clientY };
        if (hit.region === "size") {
          host.editText({
            shapeId: shape.id,
            field: "size",
            label: "Size",
            value: `${Math.round(shape.frame.width)}×${Math.round(shape.frame.height)}`,
            commit: (value) => {
              const size = parseSize(value);
              if (size) host.resizeShape(shape.id, size);
            },
          });
        }
        if (hit.region === "scale") {
          host.openMenu(
            at,
            EXPORT_SCALES.map((scale) => ({
              id: String(scale),
              label: `${scale}×`,
              checked: scale === exportScale(shape),
              run: () => host.updateData(shape.id, { exportScale: scale }),
            })),
          );
        }
        if (hit.region === "export") {
          const name =
            (typeof shape.data.text === "string" && shape.data.text) || "section";
          host.openMenu(
            at,
            (["png", "jpg"] as const).map((format) => ({
              id: format,
              label: format.toUpperCase(),
              run: () =>
                host.exportRegion({
                  region: shape.frame,
                  scale: exportScale(shape),
                  format,
                  name,
                  exclude: shape.id,
                }),
            })),
          );
        }
      },
    };
  },

  addProperties() {
    return [
      { kind: "toggle", id: "clip", label: "Clip contents", default: false },
    ] as const;
  },

  addBehavior() {
    return {
      transform: {
        move: true,
        resize: "box" as const,
        rotate: false,
        handles: "edges" as const,
      },
      // Behind everything else: a section frames content rather than covering it.
      zOrder: -1,
      container: {
        // A clipping section crops what it holds, so its contents may overhang it.
        containsBounds: (section, bounds) =>
          sectionClips(section)
            ? sectionContainsPoint(section, {
                x: bounds.x + bounds.width / 2,
                y: bounds.y + bounds.height / 2,
              })
            : bounds.x >= section.frame.x &&
              bounds.y >= section.frame.y &&
              bounds.x + bounds.width <= section.frame.x + section.frame.width &&
              bounds.y + bounds.height <= section.frame.y + section.frame.height,
        containsPoint: sectionContainsPoint,
        clips: sectionClips,
      },
    };
  },
});


// The title row (screen-space, above the frame) takes priority over the border
// (world-space edge band); the interior is click-through (null).
function hitTestSection(
  shape: CanvasShape,
  world: { x: number; y: number },
  helpers: CanvasHitTestHelpers,
): "title" | "border" | "scale" | "export" | "size" | null {
  const screen = helpers.worldToScreen(world);
  const origin = helpers.chromePosition(shape);
  const controls = sectionControlsAt(shape, helpers);
  if (controls && screen.y >= origin.y && screen.y <= origin.y + controls.row.height) {
    const chip = controls.chips.find(
      (control) => screen.x >= control.x && screen.x <= control.x + control.width,
    );
    if (chip) return chip.region;
    const size = controls.size;
    if (screen.x >= size.x - 4 && screen.x <= size.x + size.width + 4) return "size";
  }
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

  const local = localPointInShape(shape.frame, world);
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
