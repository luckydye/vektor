import type { WorldTransform } from "./transform";

export interface WorldOverlayLayer {
  // The viewport-sized clipping element. Append this beside the canvas.
  readonly root: HTMLElement;
  // Add world-space DOM/SVG content here. The layer applies the camera transform
  // to this element, so children can use world units for left/top/width/height.
  readonly content: HTMLElement;
  // Apply the current world -> screen transform. Call this whenever the camera
  // or screen size changes.
  sync(transform: WorldTransform): void;
  // Remove the overlay from the DOM.
  destroy(): void;
}

export interface WorldOverlayOptions {
  className?: string;
  contentClassName?: string;
}

export function createWorldOverlayLayer(
  doc: Document = document,
  options: WorldOverlayOptions = {},
): WorldOverlayLayer {
  const root = doc.createElement("div");
  root.style.position = "absolute";
  root.style.inset = "0";
  root.style.overflow = "hidden";
  root.style.pointerEvents = "none";
  if (options.className) root.className = options.className;

  const content = doc.createElement("div");
  content.style.position = "absolute";
  content.style.left = "0";
  content.style.top = "0";
  content.style.width = "0";
  content.style.height = "0";
  content.style.transformOrigin = "0 0";
  content.style.pointerEvents = "none";
  content.style.willChange = "transform";
  if (options.contentClassName) content.className = options.contentClassName;
  root.appendChild(content);

  function sync(transform: WorldTransform) {
    content.style.transform = `translate(${transform.dx}px, ${transform.dy}px) scale(${transform.scale})`;
  }

  function destroy() {
    root.remove();
  }

  return { root, content, sync, destroy };
}
