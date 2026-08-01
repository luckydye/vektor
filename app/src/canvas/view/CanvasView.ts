import type { CanvasTool } from "#canvas/extensions/types.ts";
import type { TranslationKey } from "#utils/lang.ts";

/** A toolbar entry. Assembled per canvas, since extensions contribute tools. */
export interface CanvasToolDef {
  id: CanvasTool;
  label: TranslationKey;
  shortcut: string;
  icon: string;
}

/** Element handles the template writes and the controller reads. */
export interface CanvasDomRefs {
  viewport: HTMLElement | null;
  scene: HTMLCanvasElement | null;
  activeInk: HTMLCanvasElement | null;
  selection: HTMLCanvasElement | null;
  shapePopover: (HTMLElement & { hide: () => void }) | null;
  canvasToolbar:
    | (HTMLElement & { editor: unknown; dismiss: () => void; reposition: () => void })
    | null;
  activeEditorElement: HTMLElement | null;
}
