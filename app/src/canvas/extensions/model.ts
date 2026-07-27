import "#model-viewer/ModelViewerElement.ts";
import { MODEL_VIEWER_TAG } from "#model-viewer/ModelViewerElement.ts";
import {
  CANVAS_ELEMENT_EVENTS,
  CanvasElementBase,
  dragOnPointerDown,
} from "./CanvasElementBase.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

// A 3D model on the canvas: a resizable, transparent shape that hosts the
// reusable <model-viewer-3d> WebGPU preview. Distinct from the generic `file`
// card so models get proper box-resize handles and fill their frame, while PDFs
// and other files keep their fixed-size card.

function modelSource(shape: CanvasShape) {
  return typeof shape.data.src === "string" ? shape.data.src : "";
}

function modelName(shape: CanvasShape) {
  return typeof shape.data.alt === "string" ? shape.data.alt : "";
}

export const modelElement: CanvasElementExtension = {
  type: "model",
  defaults: {
    size: { width: 260, height: 220 },
    minSize: { width: 120, height: 100 },
    style: { color: "transparent" },
    data: { text: "" },
  },
  isValid: (shape) => Boolean(modelSource(shape)),
  render: { surface: "dom", tag: "canvas-model", article: { background: false } },
  behavior: { transform: { move: true, resize: "box", rotate: false } },
  storage: {
    parseData: (data, context) => {
      const src = data.src;
      return {
        ...data,
        src:
          typeof src === "string" && src.startsWith("/")
            ? `${context.currentOrigin}${src}`
            : src,
      };
    },
  },
};

// The <model-viewer-3d> preview keeps pointer-events off so canvas gestures
// (move/select, and the resize handles drawn as host chrome) pass straight
// through — on the canvas the model just auto-spins; orbit stays an
// editor/inline nicety.
class CanvasModelElement extends CanvasElementBase {
  private viewer: HTMLElement | null = null;

  protected mount() {
    const wrap = document.createElement("div");
    wrap.className = "canvas-shape-model";
    wrap.style.cssText = "width:100%;height:100%;position:relative;";
    dragOnPointerDown(wrap, (event) =>
      this.emit(CANVAS_ELEMENT_EVENTS.requestDrag, event),
    );

    const viewer = document.createElement(MODEL_VIEWER_TAG);
    viewer.style.cssText = "display:block;width:100%;height:100%;pointer-events:none;";
    wrap.appendChild(viewer);
    this.appendChild(wrap);
    this.viewer = viewer;
  }

  protected update() {
    const shape = this.shapeData;
    if (!this.viewer || !shape) return;
    const src = modelSource(shape);
    if (src && this.viewer.getAttribute("src") !== src) {
      this.viewer.setAttribute("src", src);
    }
    this.viewer.setAttribute("aria-label", modelName(shape) || "3D model");
  }
}

if (typeof customElements !== "undefined" && !customElements.get("canvas-model")) {
  customElements.define("canvas-model", CanvasModelElement);
}

export function createModelShape(params: {
  at: { x: number; y: number };
  src: string;
  filename: string;
  origin?: "center" | "top-left";
}): CanvasShape {
  const origin = params.origin ?? "center";
  const size = modelElement.defaults.size;
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "model",
    frame: {
      x: Math.round(origin === "center" ? params.at.x - size.width / 2 : params.at.x),
      y: Math.round(origin === "center" ? params.at.y - size.height / 2 : params.at.y),
      width: size.width,
      height: size.height,
      rotation: 0,
    },
    style: { ...modelElement.defaults.style },
    data: { ...modelElement.defaults.data, src: params.src, alt: params.filename },
    updatedAt: Date.now(),
  };
}
