import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.solid.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import type { TranslationKey } from "#utils/lang.ts";
import type { CanvasElementContext } from "./extensions/CanvasElementBase.ts";
import type { DrawStrokeMode } from "./extensions/drawing.ts";
import type { CanvasColorPalette } from "./extensions/registry.ts";
import type { CanvasShapeLibraryItem } from "./extensions/shape.ts";
import type {
  CanvasEditSession,
  CanvasShape,
  CanvasShapeType,
  CanvasStroke,
  CanvasTool,
} from "./extensions/types.ts";
import type { ScalableSelection } from "./selectionModel.ts";
import type { Rect } from "./viewport/bounds.ts";
import type { CanvasPoint } from "./viewport/geometry.ts";
import type { WorldTransform } from "./viewport/transform.ts";

/**
 * The contract between the canvas controller and its template.
 *
 * Reads are getters or zero-argument functions rather than plain values,
 * because the template runs on every flush and must see the current state — a
 * snapshot object would go stale between renders. The derived ones are the
 * controller's cached computations, so calling them repeatedly in one render is
 * free.
 */
export interface CanvasView {
  readonly isDarkMode: boolean;
  readonly activeTool: CanvasTool;
  readonly activeColors: Record<string, string>;
  readonly penColor: string;
  readonly selectedShapeIds: ReadonlySet<string>;
  readonly selectedStrokeIds: ReadonlySet<string>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly marqueeRect: Rect | null;
  readonly contextMenuPos: CanvasPoint | null;
  readonly localPointerScreen: CanvasPoint | null;
  readonly isCameraMoving: boolean;
  readonly activeEditSession: CanvasEditSession | null;
  readonly activeDrawStrokeMode: DrawStrokeMode;
  readonly activeShapeId: string;
  readonly cursorColor: string;
  readonly cursorCompanion: string | null;
  /** Toolbar entries, including those contributed by extensions. */
  readonly tools: readonly CanvasToolDef[];

  transform(): WorldTransform;
  domShapes(): CanvasShape[];
  uploadPlaceholders(): Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    filename: string;
  }>;
  editingChromeShape(): CanvasShape | null;
  hasToolProperties(): boolean;
  hasSelectedElementProperties(): boolean;
  activeToolColorPalettes(): CanvasColorPalette[];
  selectedShapeColorPalette(): CanvasColorPalette | undefined;
  selectedShape(): CanvasShape | null;
  selectedStrokeColor(): string | null;
  selectedTransformShape(): CanvasShape | null;
  selectedResizeOnlyShape(): CanvasShape | null;
  selectedScalableSelection(): ScalableSelection | null;
  selectedBasicShapeStroke(): CanvasStroke | null;
  selectedBasicShapeStrokeControls(): {
    rotation: CanvasPoint;
    resize: CanvasPoint;
  } | null;
  hoveredLockedElementPosition(): CanvasPoint | null;
  remoteCanvasPointerPresences(): CollaborationPresenceProfile<CanvasPresenceState>[];
  viewportCursor(): string;
  hostContext(): CanvasElementContext;

  articleStyle(shape: CanvasShape): Record<string, string>;
  isBrowserFindTarget(shape: CanvasShape): boolean;
  elementTagForShape(shape: CanvasShape): string | null;
  elementDataForShape(shape: CanvasShape): unknown;
  editorTagForShape(shape: CanvasShape): string | undefined;
  elementChromePosition(shape: CanvasShape): CanvasPoint;
  transformControlPositions(shape: CanvasShape): {
    rotation: CanvasPoint;
    resize: CanvasPoint;
  };
  selectionScaleControlPosition(bounds: Rect): CanvasPoint;
  worldToScreen(point: CanvasPoint): CanvasPoint;

  setActiveTool(tool: CanvasTool): void;
  setActiveDrawStrokeMode(mode: DrawStrokeMode): void;
  setActiveElementColor(type: CanvasShapeType, color: string): void;
  setActivePenColor(color: string): void;
  setSelectedElementColor(type: CanvasShapeType, color: string): void;
  setSelectedStrokeColor(color: string): void;
  pickShapeLibraryItem(item: CanvasShapeLibraryItem): void;
  closeContextMenu(): void;
  undo(): void;
  redo(): void;
  fitView(): void;
  lockSelectedElements(): void;
  unlockHoveredElement(): void;
  copySelectionToClipboard(): void;
  cutSelectionToClipboard(): void;
  pasteFromContextMenu(): void;
  uploadFromContextMenu(): void;
  deleteSelectedShape(): void;
  stopActiveEdit(): void;
  finishChromeEditing(): void;
  setActiveEditorRef(instance: unknown): void;

  startShapeDrag(shape: CanvasShape, event: PointerEvent): void;
  startShapeRotation(shape: CanvasShape, event: PointerEvent): void;
  startShapeResize(shape: CanvasShape, event: PointerEvent): void;
  startSelectionScale(selection: ScalableSelection, event: PointerEvent): void;
  startStrokeRotation(stroke: CanvasStroke, event: PointerEvent): void;
  startStrokeResize(stroke: CanvasStroke, event: PointerEvent): void;
  onElementActivate(shape: CanvasShape, event: MouseEvent): void;
  onElementOpen(shape: CanvasShape, event: Event): void;
  handleContextMenu(event: MouseEvent): void;
  handleViewportPointerDown(event: PointerEvent): void;
  handlePointerCancel(event: PointerEvent): void;
  handlePointerLeave(event: PointerEvent): void;
  handleViewportDoubleClick(event: MouseEvent): void;
  handleDragOver(event: DragEvent): void;
  handleDrop(event: DragEvent): void;
  handleBrowserFindMatch(event: Event): void;
}

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
