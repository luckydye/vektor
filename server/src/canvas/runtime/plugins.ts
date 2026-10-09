/**
 * Inspectors and image processors registered while the canvas runs, by app
 * extensions. Element types stay compile-time: a shape whose type is missing
 * at load is pruned from the document.
 */
import type {
  CanvasPointerGestureCancelReason,
  CanvasShape,
  CanvasShapeType,
} from "#canvas/runtime/extensionApi.ts";

/** What an inspector reads and writes; its data is the owner's slot on the shape. */
export interface CanvasInspectorHandle {
  shape: () => CanvasShape;
  data: <T>() => T | undefined;
  /** Merged into the owner's slot as one undoable edit. */
  update: (patch: Record<string, unknown>) => void;
  /** Fires when the shape changes, locally or from a peer. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Hands pointer input over the inspected shape to `mode` until it exits: on
   * Escape, a selection or tool change, the shape's deletion, or the panel closing.
   * Returns its session, or null when the shape is locked.
   */
  beginEdit: (mode: CanvasEditMode) => CanvasEditModeSession | null;
}

/** A point in the shape's own space: 0..1 across its frame, rotation removed. */
export type CanvasLocalPoint = { x: number; y: number };

export interface CanvasEditPointer {
  local: CanvasLocalPoint;
  /** Coalesced samples since the last event, oldest first, ending at `local`. */
  samples: readonly (CanvasLocalPoint & { pressure: number })[];
  /** Whether `local` lies within the frame. */
  inside: boolean;
  /** Modifiers, button and pointer type. */
  event: PointerEvent;
}

/** What an edit mode can do while it runs. */
export interface CanvasEditModeSession {
  shape: () => CanvasShape;
  /** Screen pixels per local unit, horizontally and vertically, at the current zoom. */
  scale: () => { x: number; y: number };
  /** A CSS cursor for the canvas, such as a data-URL brush ring; null for the default. */
  setCursor: (cursor: string | null) => void;
  /** Drawing over the shape that is never stored or exported; replaces the previous set. */
  setOverlay: (items: readonly CanvasOverlayItem[]) => void;
  exit: () => void;
}

/**
 * Pointer handling for one shape, such as a brush. Panning (middle or right
 * button) and wheel zoom stay with the canvas.
 */
export interface CanvasEditMode {
  onPointerDown: (input: CanvasEditPointer, session: CanvasEditModeSession) => void;
  onPointerMove: (input: CanvasEditPointer, session: CanvasEditModeSession) => void;
  onPointerUp: (input: CanvasEditPointer, session: CanvasEditModeSession) => void;
  onCancel?: (reason: CanvasPointerGestureCancelReason, session: CanvasEditModeSession) => void;
  /** The pointer moved with no button held; null when it left the canvas. */
  onHover?: (input: CanvasEditPointer | null, session: CanvasEditModeSession) => void;
  /** A key while active, other than Escape (which exits). Return true when handled. */
  onKey?: (event: KeyboardEvent, session: CanvasEditModeSession) => boolean;
  /** The zoom changed, so anything sized in screen pixels needs redoing. */
  onView?: (session: CanvasEditModeSession) => void;
  onExit?: () => void;
}

/**
 * Positions are local. A path's `width` and a circle's `radius` are local too
 * (fractions of the frame width) unless `unit` is "screen"; `strokeWidth` is
 * always screen pixels.
 */
export type CanvasOverlayItem = { unit?: "local" | "screen" } & (
  | { kind: "path"; points: readonly CanvasLocalPoint[]; width: number; color: string }
  | {
      kind: "circle";
      center: CanvasLocalPoint;
      radius: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
    }
);

/** A panel shown while a single shape of one of `types` is selected. */
export interface CanvasInspector {
  id: string;
  owner: string;
  types: readonly CanvasShapeType[];
  title: string;
  /** Renders into a shadow-root container and returns its cleanup. */
  render: (container: HTMLElement, handle: CanvasInspectorHandle) => () => void;
}

export interface CanvasImageProcessInput {
  shape: CanvasShape;
  /** The owner's slot on the shape. */
  params: unknown;
  /** The resolution tier being painted: a preview on screen, the original on export. */
  sourceUrl: string;
  signal: AbortSignal;
  /**
   * Shows an intermediate result, such as a low-resolution pass, while the job
   * goes on. Ignored once the job is aborted; the resolved value replaces it.
   */
  progress: (image: TexImageSource) => void;
}

/** Replaces an image's pixels on shapes that carry data in the owner's slot. */
export interface CanvasImageProcessor {
  id: string;
  owner: string;
  types: readonly CanvasShapeType[];
  process: (input: CanvasImageProcessInput) => Promise<TexImageSource>;
}

/** Where an owner keeps its per-shape data, top-level so owners never collide. */
export function pluginDataKey(owner: string): string {
  return `extension:${owner}`;
}

/**
 * The one field the engine reads inside a slot: `disabled: true` keeps the edit
 * but paints the image without it, toggled by the inspector's eye.
 */
export function slotDisabled(shape: CanvasShape, owner: string): boolean {
  const slot = shape.data[pluginDataKey(owner)];
  return typeof slot === "object" && slot !== null && "disabled" in slot && slot.disabled === true;
}

export function createCanvasPlugins() {
  const inspectors = new Map<string, CanvasInspector>();
  const processors = new Map<string, CanvasImageProcessor>();
  const listeners = new Set<() => void>();

  function changed() {
    for (const listener of [...listeners]) listener();
  }

  function add<T extends { id: string }>(map: Map<string, T>, item: T) {
    if (map.has(item.id))
      throw new Error(`Canvas plugin is already registered: ${item.id}`);
    map.set(item.id, item);
    changed();
  }

  function remove(map: Map<string, unknown>, id: string) {
    if (map.delete(id)) changed();
  }

  return {
    registerInspector: (inspector: CanvasInspector) => add(inspectors, inspector),
    unregisterInspector: (id: string) => remove(inspectors, id),
    registerProcessor: (processor: CanvasImageProcessor) => add(processors, processor),
    unregisterProcessor: (id: string) => remove(processors, id),

    inspectorsFor: (type: CanvasShapeType) =>
      [...inspectors.values()].filter((inspector) => inspector.types.includes(type)),

    /** The processor whose owner has data on `shape`; there is no chaining. */
    processorFor(shape: CanvasShape): CanvasImageProcessor | null {
      const matches = [...processors.values()].filter(
        (processor) =>
          processor.types.includes(shape.type) &&
          shape.data[pluginDataKey(processor.owner)] !== undefined &&
          !slotDisabled(shape, processor.owner),
      );
      if (matches.length > 1) {
        throw new Error(
          `Shape ${shape.id} has data for several image processors: ${matches.map((p) => p.id).join(", ")}`,
        );
      }
      return matches[0] ?? null;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type CanvasPlugins = ReturnType<typeof createCanvasPlugins>;

export function createInspectorHandle(options: {
  owner: string;
  shape: () => CanvasShape;
  write: (patch: Record<string, unknown>) => void;
  beginEdit: (mode: CanvasEditMode) => CanvasEditModeSession | null;
}): CanvasInspectorHandle & { notify: () => void } {
  const key = pluginDataKey(options.owner);
  const listeners = new Set<() => void>();
  const data = <T>() => options.shape().data[key] as T | undefined;

  return {
    shape: options.shape,
    data,
    beginEdit: options.beginEdit,
    update(patch) {
      options.write({ [key]: { ...data<Record<string, unknown>>(), ...patch } });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}
