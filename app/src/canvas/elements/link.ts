import { ref } from "vue";
import { api } from "#api/client.ts";
import type { LinkMetadata } from "#api/routes/v1/url-metadata.ts";
import type { CanvasElementExtension, CanvasShape } from "./types.ts";

export const linkElement: CanvasElementExtension = {
  type: "link",
  defaultText: "",
  defaultColor: "var(--canvas-link-bg, #ffffff)",
  defaultSize: { width: 320, height: 200 },
  minSize: { width: 200, height: 80 },
  isValid: (shape) => Boolean(shape.src),
  surface: "dom",
  tag: "canvas-link",
  // Link cards fit their height to the preview content once it loads.
  transform: { move: true, resize: "none", rotate: false },
  autosize: "observe-dom",
};

export function createLinkShape(url: string, at: { x: number; y: number }): CanvasShape {
  return {
    id: `shape-${crypto.randomUUID()}`,
    type: "link",
    x: Math.round(at.x - linkElement.defaultSize.width / 2),
    y: Math.round(at.y - linkElement.defaultSize.height / 2),
    width: linkElement.defaultSize.width,
    height: linkElement.defaultSize.height,
    rotation: 0,
    text: "",
    color: linkElement.defaultColor,
    src: url,
    updatedAt: Date.now(),
  };
}

export type LinkPreviewState = {
  status: "loading" | "loaded" | "error";
  metadata: LinkMetadata | null;
};

export function createLinkPreviewController() {
  const previews = ref(new Map<string, LinkPreviewState>());

  function setPreview(url: string, state: LinkPreviewState) {
    const next = new Map(previews.value);
    next.set(url, state);
    previews.value = next;
  }

  async function loadPreview(url: string) {
    const existing = previews.value.get(url);
    if (existing?.status === "loading" || existing?.status === "loaded") return;

    setPreview(url, { status: "loading", metadata: null });

    try {
      const metadata = await api.linkPreview.get(url);
      setPreview(url, { status: "loaded", metadata });
    } catch {
      setPreview(url, { status: "error", metadata: null });
    }
  }

  function previewForShape(shape: CanvasShape): LinkPreviewState | undefined {
    return shape.src ? previews.value.get(shape.src) : undefined;
  }

  return { previews, loadPreview, previewForShape };
}
