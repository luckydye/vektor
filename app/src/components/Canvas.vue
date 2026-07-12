<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  toRaw,
  watch,
} from "vue";
import * as Y from "yjs";
import { api } from "#api/client.ts";
import type { CanvasElementContext } from "#canvas/extensions/CanvasElementBase.ts";
import {
  createDocumentLinkController,
  type DocumentLinkReference,
  dragHasDocumentLink,
} from "#canvas/extensions/documentLink.ts";
import {
  addCanvasDrawingPoint,
  type CanvasDrawingSession,
  cloneFreehandPoint,
  createStrokeMap,
  DRAW_STROKE_MODES,
  type DrawStrokeMode,
  FREEHAND_STYLE,
  finishCanvasDrawingStroke,
  hitTestCanvasStroke,
  PEN_COLORS,
  renderCanvasInk,
  renderCanvasSelections,
  startCanvasDrawingStroke,
  strokeStyleFromUnknown,
  toCanvasStroke,
} from "#canvas/extensions/drawing.ts";
import { pasteFigmaClipboard } from "#canvas/extensions/figma.ts";
import {
  canvasFilesFromList,
  createUploadedFileShape,
  dragHasCanvasFiles,
} from "#canvas/extensions/files.ts";
import {
  type CanvasInputContext,
  routeCanvasDrop,
  routeCanvasPaste,
  routeContextMenuPaste,
} from "#canvas/extensions/inputs.ts";
import {
  createLinkPreviewController,
  createLinkShape,
  isTwitterLinkPreview,
} from "#canvas/extensions/link.ts";
import {
  createUploadedMediaShape,
  mediaFilesFromList,
  uploadMediaFile,
} from "#canvas/extensions/media.ts";
import { NOTE_COLORS } from "#canvas/extensions/note.ts";
import {
  canvasElementTools,
  defaultColorForShape,
  defaultSizeForShape,
  defaultTextForShape,
  getCanvasElementExtension,
  isCanvasShapeType,
  isValidCanvasShape,
  minSizeForShape,
  serializeCanvasShape,
  shapePersistsSize,
} from "#canvas/extensions/registry.ts";
import { SECTION_COLORS } from "#canvas/extensions/section.ts";
import {
  type CanvasShapeLibraryItem,
  createShapeStroke,
  getShapeLibraryItem,
  SHAPE_LIBRARY,
} from "#canvas/extensions/shape.ts";
import type {
  CanvasEditSession,
  CanvasExtensionHost,
  CanvasPaintHelpers,
  CanvasSerializedShape,
  CanvasShape,
  CanvasShapeType,
  CanvasSnapshot,
  CanvasStroke,
  CanvasStrokeSnapshot,
  CanvasTool,
} from "#canvas/extensions/types.ts";
import {
  normalizeRotation,
  pointInRotatedShape,
  pointOnRotatedShape,
  resizeRotatedShapeFromBottomRight,
  rotatedShapeBounds,
  rotatedShapeCorners,
  rotateVector,
  rotationFromPointer,
  snapRotation,
} from "#canvas/geometry.ts";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import { useDocument } from "#composeables/useDocument.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import {
  canvasFitViewIcon,
  canvasSelectIcon,
  canvasShapeIcon,
  clipboardDocumentIcon,
  copyIcon,
  lockIcon,
  pencilIcon,
  redoArrowIcon,
  scissorsIcon,
  trashIcon,
  undoArrowIcon,
  unlockIcon,
  uploadIcon,
} from "~/src/assets/icons.ts";
import "#editor/elements/rich-text-editor.ts";
import "#editor/elements/toolbar.ts";
import "@atrium-ui/elements/popover";
import { useToast } from "#composeables/useToast.ts";
import {
  CANVAS_CLIPBOARD_MIME,
  type CanvasClipboard,
  canvasClipboardToDocumentHtml,
  canvasClipboardToPlainText,
  createCanvasClipboard,
  documentClipboardToCanvasShapes,
  serializeCanvasClipboard,
} from "#utils/clipboard.ts";
import {
  createVektorDocumentAddress,
  type ParsedVektorDocumentAddress,
  parseVektorDocumentAddress,
} from "#utils/documentAddress.ts";
import { sanitizeVektorDocumentPreviewHtml } from "#utils/documentHtmlSanitizer.ts";
import {
  filenameFromUrl,
  IMAGE_RESIZE_TIERS,
  resizeImageUrl,
} from "#utils/imageUrlTransformers.ts";
import { type TranslationKey, t } from "#utils/lang.ts";
import { mediaTypeForFile } from "#utils/uploadFiles.ts";
import {
  CANVAS_CURSOR_COLOR_CHANGE_EVENT,
  CANVAS_CURSOR_COLOR_STORAGE_KEY,
  readCanvasCursorColor,
} from "#utils/userPreferences.ts";
import {
  buildTransform,
  computeSnapGuides,
  createViewportControls,
  drawWorldDots,
  drawWorldGrid,
  type FitReference,
  type FreehandPoint,
  type FreehandStroke,
  panCameraByScreenDelta,
  type ScreenSize,
  type SnapGuide,
  type SnapTarget,
  snapRectToGuides,
  type ViewportCamera,
  type ViewportControls,
  screenToWorld as viewportScreenToWorld,
  worldToScreen as viewportWorldToScreen,
  type WorldRect,
  worldViewportBounds,
} from "#viewport/index.ts";

const props = defineProps<{
  spaceId: string;
  documentId?: string;
  ydoc: Y.Doc;
  presenceProfiles?: CollaborationPresenceProfile<CanvasPresenceState>[];
}>();

const emit = defineEmits<{
  presence: [states: CanvasPresenceState[]];
}>();

type DragState =
  | {
      type: "shape";
      pointerId: number;
      startPointer: { x: number; y: number };
      // Every shape and stroke that moves with this drag (the grabbed shape,
      // anything else in the selection, and the contents of any dragged
      // section), captured at their starting positions.
      shapes: { id: string; x: number; y: number }[];
      strokes: { id: string; points: FreehandPoint[] }[];
    }
  | {
      type: "resize";
      pointerId: number;
      shapeId: string;
      fixedTopLeft: { x: number; y: number };
      minSize: { width: number; height: number };
      // Locked width/height ratio for media; undefined lets the axes move freely.
      aspect?: number;
      // Text scales its font instead of a fixed box.
      isText?: boolean;
      initialFontScale?: number;
      initial: Pick<CanvasShape, "x" | "y" | "width" | "height" | "rotation">;
    }
  | {
      type: "rotate";
      pointerId: number;
      shapeId: string;
      center: { x: number; y: number };
      initial: Pick<CanvasShape, "x" | "y" | "width" | "height" | "rotation">;
    }
  | {
      type: "stroke-resize";
      pointerId: number;
      strokeId: string;
      fixedTopLeft: { x: number; y: number };
      startBounds: Rect;
      initialPoints: FreehandPoint[];
    }
  | {
      type: "stroke-rotate";
      pointerId: number;
      strokeId: string;
      center: { x: number; y: number };
      startRotation: number;
      initialRotation: number;
      initialPoints: FreehandPoint[];
    }
  | {
      type: "pan";
      pointerId: number;
      startPointer: { x: number; y: number };
      startCamera: ViewportCamera;
    }
  | {
      type: "marquee";
      pointerId: number;
      additive: boolean;
      startScreen: { x: number; y: number };
      baseShapeIds: Set<string>;
      baseStrokeIds: Set<string>;
    };

type Rect = { x: number; y: number; width: number; height: number };
type LockedCanvasElement = { type: "shape" | "stroke"; id: string };

const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
type ToolDef = {
  id: CanvasTool;
  label: TranslationKey;
  shortcut: string;
  icon: string;
};

// Built-in engine tools plus the element-contributed tools (note/text/section)
// collected from the registry, so adding an element type surfaces its tool
// without editing the host.
const CANVAS_TOOLS: ToolDef[] = [
  { id: "select", label: "Select", shortcut: "V", icon: canvasSelectIcon },
  { id: "draw", label: "Draw", shortcut: "D", icon: pencilIcon },
  ...canvasElementTools(),
];
const viewportRef = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLCanvasElement | null>(null);
const sectionsRef = ref<HTMLCanvasElement | null>(null);
const inkRef = ref<HTMLCanvasElement | null>(null);
const imagesRef = ref<HTMLCanvasElement | null>(null);
const selectionRef = ref<HTMLCanvasElement | null>(null);
const imageCache = new Map<string, HTMLImageElement | "loading" | "error">();
const shapes = shallowRef<CanvasShape[]>([]);
const strokes = shallowRef<CanvasStroke[]>([]);
// Local-only placeholders shown on the canvas while a dropped/pasted file
// uploads. They are never written to Yjs, so they are not persisted or shared
// with other collaborators; the real shape replaces the placeholder once the
// upload finishes.
type UploadPlaceholder = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  filename: string;
  kind: "image" | "video" | "audio" | "file";
};
const uploadPlaceholders = ref<UploadPlaceholder[]>([]);

function addUploadPlaceholder(
  kind: UploadPlaceholder["kind"],
  filename: string,
  at: { x: number; y: number },
): string {
  const size = defaultSizeForShape(kind);
  const id = `upload-${crypto.randomUUID()}`;
  uploadPlaceholders.value = [
    ...uploadPlaceholders.value,
    {
      id,
      x: Math.round(at.x - size.width / 2),
      y: Math.round(at.y - size.height / 2),
      width: size.width,
      height: size.height,
      filename,
      kind,
    },
  ];
  return id;
}

function removeUploadPlaceholder(id: string) {
  uploadPlaceholders.value = uploadPlaceholders.value.filter(
    (placeholder) => placeholder.id !== id,
  );
}
const selectedShapeIds = ref<Set<string>>(new Set());
const selectedStrokeIds = ref<Set<string>>(new Set());
// Locked elements are intentionally excluded from normal hit testing. Keep a
// separate hover target so their small unlock control remains reachable.
const hoveredLockedElement = ref<LockedCanvasElement | null>(null);
// Section chrome is painted on the canvas. This transient input only appears
// while its title is actively being edited.
const editingSectionTitleId = ref<string | null>(null);
// Live screen-space rectangle while drag-selecting; null when not marqueeing.
const marqueeRect = ref<Rect | null>(null);
// Alignment guides shown while dragging shapes; empty when no edge/center of
// the dragged group is snapped to another shape. Drawn on the ink overlay.
let activeSnapGuides: SnapGuide[] = [];
// How close (in screen px) a dragged edge/center must come to another shape's
// edge/center before it snaps to it.
const SNAP_THRESHOLD_PX = 6;
// Only shapes within this screen-space margin of the dragged group are
// considered as snap targets, so a canvas with hundreds of elements stays fast.
const SNAP_PROXIMITY_PX = 320;
// True only while a pan drag is in progress, so the viewport shows the grabbing
// hand during panning and a resting cursor otherwise.
const isPanning = ref(false);
const activeTool = ref<CanvasTool>("select");
// Library entry the shape tool places next; the toolbar popover changes it.
const activeShapeId = ref<string>(SHAPE_LIBRARY[0].id);
const shapePopoverRef = ref<(HTMLElement & { hide: () => void }) | null>(null);
// Shared inline-formatting toolbar (<document-toolbar variant="canvas">),
// retargeted to whichever text shape's editor is focused.
type CanvasFormatToolbarEl = HTMLElement & {
  editor: unknown;
  dismiss: () => void;
  reposition: () => void;
};
const canvasToolbarRef = ref<CanvasFormatToolbarEl | null>(null);
const noteColor = ref<string>(NOTE_COLORS[0]);
const sectionColor = ref<string>(SECTION_COLORS[0]);
const penColor = ref<string>(PEN_COLORS[0]);
const cursorColor = ref<string>(readCanvasCursorColor());
const drawStrokeMode = ref<DrawStrokeMode>("pen");
// Backdrop grid style, driven by the document's "gridtype" property. "grid"
// draws ruled lines, "dots" a dot grid, and "clean" leaves the backdrop empty.
type GridType = "grid" | "clean" | "dots";
const gridType = ref<GridType>("dots");
const saveState = ref<"idle" | "saving" | "saved">("idle");
const toast = useToast();
const isDarkMode = ref(false);
let localPointer: { x: number; y: number } | null = null;

const camera = ref<ViewportCamera>({ centerX: 0, centerY: 0, zoom: 1 });
const screen = ref<ScreenSize>({ width: 1, height: 1 });
const { document: documentData, saveDocument } = useDocument(props.documentId, "canvas");
// Used to resolve dropped/inserted same-space document ids to best-effort local
// title/type metadata before the full preview loads.
const { documents } = useDocuments();
const { spaces, currentSpace } = useSpace();
const currentUser = useUserProfile();
const currentUserId = computed(() => currentUser.value?.id);
const userCanEditDocuments = computed(() => canEdit(currentSpace.value?.userRole));
// The one embedded document card currently in inline-edit mode. Only this
// card mounts a collaborative editor; every other embed stays a static
// preview so we never join Yjs/presence rooms for idle embeds.
const editingDocumentShape = ref<{
  shapeId: string;
  documentId: string;
  address: string;
  toggleTaskIndex: number | null;
} | null>(null);
// <canvas-document-editor> is a custom element exposing getHtml().
type CanvasDocumentEditorEl = HTMLElement & { getHtml: () => string | null };
const embeddedDocumentEditor = shallowRef<CanvasDocumentEditorEl | null>(null);

const ydoc = props.ydoc;
const yShapes = ydoc.getMap<Y.Map<unknown>>("canvas.shapes");
const yStrokes = ydoc.getMap<Y.Map<unknown>>("canvas.strokes");
const documentLinks = createDocumentLinkController({
  documents,
  currentOrigin:
    typeof window === "undefined" ? "http://localhost" : window.location.origin,
  currentSpaceId: props.spaceId,
  fetchDocument: async (ref) => {
    if (isRemoteDocumentAddress(ref.address)) {
      return fetchRemoteDocumentByAddress(ref);
    }
    return api.document.get(ref.spaceId, ref.documentId);
  },
  insertShape: (shape) => yShapes.set(shape.id, createShapeMap(shape)),
  selectShape: (shapeId) => selectOnlyShape(shapeId),
  afterInsert: () => {
    activeTool.value = "select";
    saveImmediately();
  },
});
const linkPreviews = createLinkPreviewController();

// Tracks only local edits (default trackedOrigins = {null}); remote/agent
// updates arrive with origin "remote" and are excluded, so undo/redo only
// reverts this user's own changes.
const undoManager = new Y.UndoManager([yShapes, yStrokes]);

function getDomainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isRemoteDocumentUrl(url: string | undefined): url is string {
  if (!url || typeof window === "undefined") return false;
  try {
    return new URL(url, window.location.origin).origin !== window.location.origin;
  } catch {
    return false;
  }
}

function isRemoteDocumentShape(shape: CanvasShape): boolean {
  return (
    shape.type === "document" && isRemoteDocumentAddress(documentAddressForShape(shape))
  );
}

function isRemoteDocumentAddress(address: string | undefined): address is string {
  const origin = parseVektorDocumentAddress(address)?.origin;
  return Boolean(
    origin && typeof window !== "undefined" && origin !== window.location.origin,
  );
}

function documentAddressForShape(shape: CanvasShape): string | undefined {
  return parseVektorDocumentAddress(shape.docAddress)?.address;
}

function legacyDocumentAddress(input: {
  docAddress?: unknown;
  docId?: unknown;
  docSpaceId?: unknown;
  src?: string;
}): string | undefined {
  if (typeof input.docAddress === "string") {
    const parsed = parseVektorDocumentAddress(input.docAddress);
    if (parsed) return parsed.address;
  }
  if (typeof input.docId !== "string" || typeof window === "undefined") return undefined;
  const href = input.src;
  let origin = window.location.origin;
  if (href) {
    try {
      origin = new URL(href, window.location.origin).origin;
    } catch {
      origin = window.location.origin;
    }
  }
  return createVektorDocumentAddress({
    origin,
    spaceId: typeof input.docSpaceId === "string" ? input.docSpaceId : props.spaceId,
    documentId: input.docId,
    href,
  });
}

async function fetchRemoteDocumentByAddress(ref: ParsedVektorDocumentAddress) {
  const response = await fetch(
    `${ref.origin}/api/v1/spaces/${encodeURIComponent(ref.spaceId)}/documents/${encodeURIComponent(ref.documentId)}`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch remote document: ${response.status}`);
  }
  const data = (await response.json()) as { document?: unknown };
  const document = data.document as
    | {
        id?: unknown;
        slug?: unknown;
        properties?: unknown;
        type?: unknown;
        content?: unknown;
      }
    | undefined;
  if (!document || typeof document.id !== "string") {
    throw new Error("Invalid remote document response");
  }
  const properties =
    document.properties && typeof document.properties === "object"
      ? (document.properties as Record<string, string | string[]>)
      : {};
  return {
    id: document.id,
    properties,
    type: typeof document.type === "string" ? document.type : "document",
    content:
      typeof document.content === "string"
        ? sanitizeVektorDocumentPreviewHtml(document.content)
        : "",
  };
}

function documentUrlPartsFromUrl(
  rawUrl: string,
): { documentId: string; spaceId?: string; spaceSlug?: string; url: string } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed, window.location.origin);
  } catch {
    return null;
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length < 2) return null;

  let spaceId: string | undefined;
  let spaceSlug: string | undefined;
  let documentPath = "";

  if (pathParts[0] === "doc" && pathParts[1]) {
    spaceId = props.spaceId;
    documentPath = pathParts.slice(1).join("/");
  } else if (pathParts[1] === "doc" && pathParts[2]) {
    spaceSlug = pathParts[0];
    documentPath = pathParts.slice(2).join("/");
  }

  if ((!spaceId && !spaceSlug) || !documentPath) return null;
  let documentId: string;
  try {
    documentId = decodeURIComponent(documentPath);
  } catch {
    return null;
  }

  return {
    documentId,
    ...(spaceId ? { spaceId } : {}),
    ...(spaceSlug ? { spaceSlug } : {}),
    url: url.href,
  };
}

async function documentReferenceFromUrl(
  rawUrl: string,
): Promise<DocumentLinkReference | null> {
  const parts = documentUrlPartsFromUrl(rawUrl);
  if (!parts) return null;
  if (parts.spaceId) {
    return {
      address: createVektorDocumentAddress({
        origin: new URL(parts.url).origin,
        spaceId: parts.spaceId,
        documentId: parts.documentId,
        href: parts.url,
      }),
    };
  }

  if (isRemoteDocumentUrl(parts.url)) return null;

  const availableSpaces = spaces.value ?? (await api.spaces.get());
  const space = availableSpaces.find((entry) => entry.slug === parts.spaceSlug);
  if (!space) return null;

  return {
    address: createVektorDocumentAddress({
      origin: window.location.origin,
      spaceId: space.id,
      documentId: parts.documentId,
      href: parts.url,
    }),
  };
}

function insertLinkShape(url: string, at: { x: number; y: number }) {
  const shape = createLinkShape(url, at);
  yShapes.set(shape.id, createShapeMap(shape));
  selectOnlyShape(shape.id);
  activeTool.value = "select";
  void linkPreviews.loadPreview(url);
  saveImmediately();
}

async function insertDocumentLinkFromReference(
  ref: DocumentLinkReference,
  at: { x: number; y: number },
  options: { fallbackToLink?: boolean } = {},
) {
  try {
    const parsed = parseVektorDocumentAddress(ref.address);
    if (!parsed) throw new Error("Invalid document address");
    const doc = isRemoteDocumentAddress(ref.address)
      ? await fetchRemoteDocumentByAddress(parsed)
      : await api.document.get(parsed.spaceId, parsed.documentId);
    documentLinks.insertDocumentLink(
      {
        address: createVektorDocumentAddress({
          origin: parsed.origin,
          spaceId: parsed.spaceId,
          documentId: doc.id,
          href: parsed.href,
        }),
      },
      at,
      doc,
    );
  } catch (err) {
    const href = parseVektorDocumentAddress(ref.address)?.href;
    if (options.fallbackToLink && href) {
      insertLinkShape(href, at);
      return;
    }
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function insertDocumentLinkFromUrl(url: string, at: { x: number; y: number }) {
  const ref = await documentReferenceFromUrl(url);
  if (!ref) {
    const metadata = await api.linkPreview.get(url).catch(() => null);
    const remoteDocument = metadata?.vektorDocument;
    if (metadata && remoteDocument) {
      documentLinks.insertDocumentLink(
        {
          address:
            remoteDocument.address ??
            createVektorDocumentAddress({
              origin: new URL(metadata.url || url).origin,
              spaceId: remoteDocument.spaceId,
              documentId: remoteDocument.documentId,
              href: metadata.url || url,
            }),
        },
        at,
        {
          properties: { title: metadata.title ?? remoteDocument.documentSlug },
        },
      );
      return;
    }
    insertLinkShape(url, at);
    return;
  }
  await insertDocumentLinkFromReference(ref, at, { fallbackToLink: true });
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
let dragState: DragState | null = null;
// True once a shape drag has actually moved the selection. Document-link cards
// read this to tell a click (open the document) from a drag (just reposition).
let dragMoved = false;
let drawingSession: CanvasDrawingSession | null = null;
let activeFreehandStroke: FreehandStroke | null = null;
// Screen-space position of the long-press context menu, null when hidden.
const contextMenuPos = ref<{ x: number; y: number } | null>(null);
// World-space insertion point captured when the context menu was opened.
let contextMenuInsertWorld: { x: number; y: number } | null = null;
let isReady = false;
let savePrunedInvalidShapesWhenReady = false;
let viewportControls: ViewportControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let colorSchemeMedia: MediaQueryList | null = null;
let dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
const textShapeSizes = shallowRef(new Map<string, { width: number; height: number }>());

const remoteCanvasPresences = computed(() => props.presenceProfiles ?? []);

const remoteCanvasPointerPresences = computed(() =>
  remoteCanvasPresences.value.filter((presence) => presence.state?.pointer),
);

const remoteCanvasSelections = computed(() =>
  remoteCanvasPresences.value.flatMap((presence) => {
    const state = presence.state;
    if (!state?.selectionIds.length) return [];

    return state.selectionIds.flatMap((itemId) => {
      const shape = shapesById.value.get(itemId);
      if (!shape) return [];
      return [
        {
          clientId: presence.clientId,
          user: presence.user,
          cursorColor:
            state.cursorColor ||
            presence.user.color ||
            getPresenceColor(presence.user.id),
          itemId,
          bounds: shapeBounds(shape),
        },
      ];
    });
  }),
);

const remoteCanvasDomSelections = computed(() =>
  remoteCanvasSelections.value.filter(
    (selection) =>
      selection.bounds.type !== "image" || isGifSrc(selection.bounds.src ?? ""),
  ),
);

const remoteCanvasImageSelections = computed(() =>
  remoteCanvasSelections.value.filter(
    (selection) =>
      selection.bounds.type === "image" && !isGifSrc(selection.bounds.src ?? ""),
  ),
);

const remoteCanvasStrokeSelections = computed(() =>
  remoteCanvasPresences.value.map((presence) => ({
    ids: new Set(
      presence.state?.selectionIds.filter((id) => strokesById.value.has(id)) ?? [],
    ),
    color:
      presence.state?.cursorColor ||
      presence.user.color ||
      getPresenceColor(presence.user.id),
  })),
);

// Remote pointers arrive as discrete presence updates; a CSS transition on the
// cursor smooths the jumps. While the local camera moves, the transition is
// suspended so cursors stay locked to the canvas instead of lagging behind the
// pan/zoom.
const isCameraMoving = ref(false);
let cameraMoveTimer: ReturnType<typeof setTimeout> | null = null;

watch(camera, () => {
  isCameraMoving.value = true;
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
  cameraMoveTimer = setTimeout(() => {
    isCameraMoving.value = false;
  }, 150);
});
// The single selected shape, or null when nothing or multiple things are
// selected. Drives the per-shape affordances (note color, resize handle) that
// only make sense for one shape at a time.
const selectedShape = computed(() => {
  if (selectedShapeIds.value.size !== 1 || selectedStrokeIds.value.size > 0) {
    return null;
  }
  const [id] = selectedShapeIds.value;
  return shapesById.value.get(id) ?? null;
});

// Transform affordances are declared per type on the extension. Types that can
// rotate get the full rotate+resize controls (note/text/media); sections and
// embedded documents declare resize without rotate, so they expose resize only.
// Everything else stays move-only.
const selectedTransformShape = computed(() => {
  const shape = selectedShape.value;
  if (!shape || !canMoveShape(shape)) return null;
  return getCanvasElementExtension(shape.type)?.transform.rotate ? shape : null;
});

const selectedResizableSection = computed(() => {
  const shape = selectedShape.value;
  return shape?.type === "section" && canMoveShape(shape) ? shape : null;
});

const selectedResizableDocument = computed(() => {
  const shape = selectedShape.value;
  return shape?.type === "document" && canMoveShape(shape) ? shape : null;
});

function transformControlPositions(shape: CanvasShape) {
  // Text auto-sizes, so anchor the handles to its measured box.
  const bounds = shapeBounds(shape);
  // Handles stay a comfortable fixed size in screen space. Convert their
  // offset back to world units before placing them around the rotated shape.
  const offset = 24 / transform.value.scale;
  const resizeOffset = 18 / transform.value.scale / Math.SQRT2;
  return {
    rotation: worldToScreen(
      pointOnRotatedShape(bounds, { x: bounds.width / 2, y: -offset }),
    ),
    resize: worldToScreen(
      pointOnRotatedShape(bounds, {
        x: bounds.width + resizeOffset,
        y: bounds.height + resizeOffset,
      }),
    ),
  };
}

// Custom-element tag an extension renders its DOM body with, but only once that
// element is actually registered. Types whose element isn't implemented yet
// return null and fall back to the inline template branches below, so migration
// can proceed one type at a time without breaking the canvas.
function elementTagForShape(shape: CanvasShape): string | null {
  const tag = getCanvasElementExtension(shape.type)?.tag;
  if (!tag || typeof customElements === "undefined" || !customElements.get(tag)) {
    return null;
  }
  // Twitter/X links keep the host-owned <CanvasTwitterEmbed> Vue component, so
  // they render through the fallback branch rather than the generic link card.
  if (
    shape.type === "link" &&
    isTwitterLinkPreview(linkPreviews.previewForShape(shape))
  ) {
    return null;
  }
  // While a document card is being edited inline, the host swaps in the
  // <CanvasDocumentEditor> Vue component (rendered from the fallback branch).
  if (shape.type === "document" && editingDocumentShape.value?.shapeId === shape.id) {
    return null;
  }
  return tag;
}

// Per-type reactive view model handed to an element via its `data` property.
// The extension resolves it from the host's controllers; the host stays generic.
function elementDataForShape(shape: CanvasShape): unknown {
  return getCanvasElementExtension(shape.type)?.resolveData?.(shape, extHost) ?? null;
}

// Sets the host-owned inline-edit slot; the document extension calls this from
// its onActivate after the can-edit checks.
function beginEdit(session: CanvasEditSession) {
  if (editingDocumentShape.value?.shapeId === session.shapeId) return;
  stopEmbeddedDocumentEdit();
  selectOnlyShape(session.shapeId);
  editingDocumentShape.value = session;
}

// Opens a linked document: remote embeds open their href in a new tab; local
// ones dispatch the app's view-document navigation event.
function openDocument(shape: CanvasShape, requestedDocumentId?: string | null) {
  const documentId = requestedDocumentId ?? documentLinks.documentIdForShape(shape);
  if (!documentId) return;
  const href = documentLinks.documentHrefForShape(shape);
  if (isRemoteDocumentShape(shape) && href) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  const spaceId = documentLinks.documentSpaceIdForShape(shape) || props.spaceId;
  window.dispatchEvent(
    new CustomEvent("view-document", { detail: { spaceId, documentId } }),
  );
}

// Services + controllers handed to the extension-level hooks (resolveData /
// onActivate / onOpen) the host dispatches, keeping the host type-agnostic.
const extHost: CanvasExtensionHost = {
  spaceId: props.spaceId,
  wasDragged: () => dragMoved,
  canEditDocuments: () => userCanEditDocuments.value,
  isRemoteDocument: (shape) => isRemoteDocumentShape(shape),
  documentAddress: (shape) => documentAddressForShape(shape),
  beginEdit,
  openDocument,
  documents: documentLinks,
  links: linkPreviews,
};

function onElementActivate(shape: CanvasShape, event: MouseEvent) {
  getCanvasElementExtension(shape.type)?.onActivate?.(shape, extHost, event);
}

function onElementOpen(shape: CanvasShape, event: Event) {
  getCanvasElementExtension(shape.type)?.onOpen?.(shape, extHost, event);
}

// Stable helpers/data handed to every element custom element via its
// `canvasContext` property. Per-shape reactive values flow through `shape`/`data`.
const hostContext: CanvasElementContext = {
  t,
  isGifSrc,
  getDomainFromUrl,
  spaceId: props.spaceId,
  wasDragged: () => dragMoved,
  setText: (id, text) => {
    const shape = shapesById.value.get(id);
    if (!shape || shape.locked) return;
    updateShape(id, { text });
  },
  removeShape: (id) => {
    if (shapesById.value.get(id)?.locked) return;
    yShapes.delete(id);
    if (selectedShapeIds.value.has(id)) {
      selectedShapeIds.value.delete(id);
      selectedShapeIds.value = new Set(selectedShapeIds.value);
    }
  },
  selectShape: (id) => selectOnlyShape(id),
  setFormattingEditor: (editor) => {
    const toolbar = canvasToolbarRef.value;
    if (toolbar) toolbar.editor = editor;
  },
};

// Non-GIF images and sections render on canvas layers. All other shapes stay in
// the DOM permanently; content-visibility:auto in CSS tells the browser to
// skip painting off-screen articles without JS involvement.
const domShapes = computed(() =>
  shapes.value.filter(
    (shape) =>
      shape.type !== "section" && (shape.type !== "image" || isGifSrc(shape.src ?? "")),
  ),
);

const sectionShapes = computed(() =>
  shapes.value.filter((shape) => shape.type === "section"),
);

const editingSectionShape = computed(() => {
  const id = editingSectionTitleId.value;
  if (!id) return null;
  const shape = shapesById.value.get(id);
  return shape?.type === "section" ? shape : null;
});

function sectionTitlePosition(shape: CanvasShape) {
  const screenGap = 32 / transform.value.scale;
  return worldToScreen(pointOnRotatedShape(shape, { x: 0, y: -screenGap }));
}

// Canvas-rendered image shapes within the current viewport. Used only by
// renderImages() to avoid drawImage calls for off-screen images.
const visibleImageShapes = computed(() => {
  const vr = worldViewportBounds(camera.value, screen.value, FIT_REFERENCE, 400);
  return shapes.value.filter(
    (shape) =>
      shape.type === "image" &&
      !isGifSrc(shape.src ?? "") &&
      rectsIntersect(vr, shapeAabb(shape)),
  );
});

const selectedStrokeColor = computed(() => {
  if (selectedStrokeIds.value.size === 0) return null;
  let color: string | null = null;
  for (const id of selectedStrokeIds.value) {
    const stroke = strokesById.value.get(id);
    if (!stroke) continue;
    if (color === null) color = stroke.style.color;
    else if (stroke.style.color !== color) return null;
  }
  return color;
});

const shapesById = computed(() => new Map(shapes.value.map((s) => [s.id, s])));
const strokesById = computed(() => new Map(strokes.value.map((s) => [s.id, s])));

function isShapeLocked(id: string): boolean {
  return shapesById.value.get(id)?.locked === true;
}

function isStrokeLocked(id: string): boolean {
  return strokesById.value.get(id)?.locked === true;
}

function canMoveUserScopedElement(authorId: string | undefined): boolean {
  // `authorId` is an internal creation-time capability, not a user-facing
  // canvas setting. Future cosmetic/sticker creators set it to the active
  // user's id; every movement path below then honors that ownership.
  return !authorId || authorId === currentUserId.value;
}

function canMoveShape(shape: CanvasShape): boolean {
  return !shape.locked && canMoveUserScopedElement(shape.authorId);
}

function canMoveStroke(stroke: CanvasStroke): boolean {
  return !stroke.locked && canMoveUserScopedElement(stroke.authorId);
}

const hoveredLockedElementPosition = computed(() => {
  const element = hoveredLockedElement.value;
  if (!element) return null;

  if (element.type === "shape") {
    const shape = shapesById.value.get(element.id);
    if (!shape?.locked) return null;
    const bounds = shapeBounds(shape);
    return worldToScreen(pointOnRotatedShape(bounds, { x: bounds.width, y: 0 }));
  }

  const stroke = strokesById.value.get(element.id);
  const bounds = stroke ? strokeBounds(stroke) : null;
  if (!stroke?.locked || !bounds) return null;
  return worldToScreen({ x: bounds.x + bounds.width, y: bounds.y });
});

const selectedBasicShapeStroke = computed(() => {
  if (selectedShapeIds.value.size > 0 || selectedStrokeIds.value.size !== 1) return null;
  const [id] = selectedStrokeIds.value;
  const stroke = strokesById.value.get(id);
  return stroke?.kind === "shape" && canMoveStroke(stroke) ? stroke : null;
});

const selectedBasicShapeStrokeControls = computed(() => {
  const stroke = selectedBasicShapeStroke.value;
  return stroke ? strokeTransformControlPositions(stroke) : null;
});

function selectOnlyShape(id: string) {
  if (isShapeLocked(id)) return;
  selectedShapeIds.value = new Set([id]);
  if (selectedStrokeIds.value.size > 0) {
    selectedStrokeIds.value = new Set();
    renderInk();
  }
}

function selectStroke(id: string, additive: boolean) {
  if (isStrokeLocked(id)) return;
  if (additive) {
    const next = new Set(selectedStrokeIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedStrokeIds.value = next;
  } else {
    selectedShapeIds.value = new Set();
    selectedStrokeIds.value = new Set([id]);
  }
  renderInk();
}

function toggleShapeSelection(id: string) {
  if (isShapeLocked(id)) return;
  const next = new Set(selectedShapeIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedShapeIds.value = next;
}

function clearSelection() {
  if (selectedShapeIds.value.size > 0) selectedShapeIds.value = new Set();
  if (selectedStrokeIds.value.size > 0) {
    selectedStrokeIds.value = new Set();
    renderInk();
  }
}

function rectsIntersect(a: Rect, b: Rect) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function rectContains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function getPresenceColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

function toNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const MIN_FONT_SCALE = 0.3;
const MAX_FONT_SCALE = 10;
const TEXT_BASE_FONT_PX = 15;

function clampFontScale(value: number) {
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, value));
}

function textShapeFallbackSize(shape: CanvasShape) {
  const minSize = minSizeForShape("text");
  const lines = (shape.text || defaultTextForShape("text")).split(/\n/);
  const longestLineLength = Math.max(1, ...lines.map((line) => line.length));
  return {
    width: Math.max(minSize.width, Math.ceil(longestLineLength * 8.5 + 26)),
    height: Math.max(minSize.height, Math.ceil(lines.length * 20.25 + 22)),
  };
}

function textShapeSize(shape: CanvasShape) {
  return textShapeSizes.value.get(shape.id) ?? textShapeFallbackSize(shape);
}

function shapeBounds(shape: CanvasShape): CanvasShape {
  if (shape.type !== "text") return shape;
  return { ...shape, ...textShapeSize(shape) };
}

function shapeAabb(shape: CanvasShape): Rect {
  return rotatedShapeBounds(shapeBounds(shape));
}

function strokeBounds(stroke: Pick<CanvasStroke, "points">): Rect | null {
  if (stroke.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function strokeTransformControlPositions(stroke: CanvasStroke) {
  const bounds = strokeBounds(stroke);
  if (!bounds) return null;
  const offset = 24 / transform.value.scale;
  const resizeOffset = 18 / transform.value.scale / Math.SQRT2;
  return {
    rotation: worldToScreen({ x: bounds.x + bounds.width / 2, y: bounds.y - offset }),
    resize: worldToScreen({
      x: bounds.x + bounds.width + resizeOffset,
      y: bounds.y + bounds.height + resizeOffset,
    }),
  };
}

// Text shapes lay themselves out from their content. Width/height are local
// measured bounds for canvas geometry, not persisted shape data.
let textShapeObserver: ResizeObserver | null = null;
const observedTextShapes = new Map<Element, string>();

type RichTextEditorWithElement = HTMLElement & { el?: HTMLElement | null };

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function borderBoxExtra(element: HTMLElement) {
  const style = getComputedStyle(element);
  return {
    width: cssPixels(style.borderLeftWidth) + cssPixels(style.borderRightWidth),
    height: cssPixels(style.borderTopWidth) + cssPixels(style.borderBottomWidth),
  };
}

function measureIntrinsicTextShapeSize(element: HTMLElement) {
  const editorElement =
    element.querySelector<RichTextEditorWithElement>("rich-text-editor");
  const editorContent =
    editorElement?.el ?? editorElement?.shadowRoot?.querySelector<HTMLElement>(".tiptap");
  const shadowRoot = editorElement?.shadowRoot;
  if (!editorContent || !shadowRoot) return null;

  const clone = editorContent.cloneNode(true) as HTMLElement;
  clone.removeAttribute("contenteditable");
  clone.removeAttribute("tabindex");
  Object.assign(clone.style, {
    position: "fixed",
    left: "-100000px",
    top: "-100000px",
    visibility: "hidden",
    pointerEvents: "none",
    width: "max-content",
    minWidth: "0",
    maxWidth: "none",
    height: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "normal",
    overflowWrap: "normal",
  });

  shadowRoot.append(clone);
  const contentWidth = Math.max(clone.scrollWidth, clone.offsetWidth);
  const contentHeight = Math.max(clone.scrollHeight, clone.offsetHeight);
  clone.remove();

  const extra = borderBoxExtra(element);
  return {
    width: Math.ceil(contentWidth + extra.width),
    height: Math.ceil(contentHeight + extra.height),
  };
}

function syncTextShapeSize(id: string, element: HTMLElement) {
  if (!yShapes.has(id)) return;

  const minSize = minSizeForShape("text");
  const intrinsicSize = measureIntrinsicTextShapeSize(element);
  const width = Math.max(
    minSize.width,
    intrinsicSize?.width ?? Math.ceil(element.offsetWidth),
  );
  const height = Math.max(
    minSize.height,
    intrinsicSize?.height ?? Math.ceil(element.offsetHeight),
  );
  const current = textShapeSizes.value.get(id);
  if (current?.width === width && current?.height === height) {
    return;
  }

  const next = new Map(textShapeSizes.value);
  next.set(id, { width, height });
  textShapeSizes.value = next;
  renderSelections();
}

function observeTextShapeSize(element: HTMLElement, shapeId: string) {
  if (observedTextShapes.get(element) === shapeId) return;
  if (!textShapeObserver && typeof ResizeObserver !== "undefined") {
    textShapeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = observedTextShapes.get(entry.target);
        if (id) syncTextShapeSize(id, entry.target as HTMLElement);
      }
    });
  }
  observedTextShapes.set(element, shapeId);
  textShapeObserver?.observe(element);
}

function syncTextShapeObservers() {
  const viewport = viewportRef.value;
  if (!viewport) return;

  const currentElements = new Set<Element>();
  for (const element of viewport.querySelectorAll<HTMLElement>(
    ".canvas-shape.text[data-shape-id]",
  )) {
    const shapeId = element.dataset.shapeId;
    if (!shapeId) continue;
    currentElements.add(element);
    observeTextShapeSize(element, shapeId);
  }

  for (const [element] of observedTextShapes) {
    if (!currentElements.has(element) || !element.isConnected) {
      const shapeId = observedTextShapes.get(element);
      textShapeObserver?.unobserve(element);
      observedTextShapes.delete(element);
      if (shapeId) {
        const next = new Map(textShapeSizes.value);
        next.delete(shapeId);
        textShapeSizes.value = next;
      }
    }
  }
}

// Link preview cards (image + title + description) have a content height that
// depends on the card width (the image keeps a 4/3 ratio) rather than a fixed
// box, so a fixed shape height clips the body. We observe each card and fit the
// shape height to its content — mirroring the text-shape auto-size machinery.
let linkShapeObserver: ResizeObserver | null = null;
const observedLinkShapes = new Map<Element, string>();

/** Sum of the card's stacked children — the true content height, independent
 *  of the (possibly clipping) shape box, so the shape can shrink as well as grow. */
function linkCardContentHeight(element: HTMLElement): number {
  let total = 0;
  for (const child of Array.from(element.children)) {
    total += (child as HTMLElement).offsetHeight;
  }
  return total;
}

function observeLinkShapeSize(element: HTMLElement, shapeId: string) {
  if (observedLinkShapes.get(element) === shapeId) return;
  if (!linkShapeObserver && typeof ResizeObserver !== "undefined") {
    linkShapeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = observedLinkShapes.get(entry.target);
        if (id)
          fitLinkShapeHeight(id, linkCardContentHeight(entry.target as HTMLElement));
      }
    });
  }
  observedLinkShapes.set(element, shapeId);
  linkShapeObserver?.observe(element);
}

function syncLinkShapeObservers() {
  const viewport = viewportRef.value;
  if (!viewport) return;

  const currentElements = new Set<Element>();
  for (const element of viewport.querySelectorAll<HTMLElement>(
    ".canvas-shape-link[data-link-shape-id]",
  )) {
    const shapeId = element.dataset.linkShapeId;
    if (!shapeId) continue;
    currentElements.add(element);
    observeLinkShapeSize(element, shapeId);
  }

  for (const [element] of observedLinkShapes) {
    if (!currentElements.has(element) || !element.isConnected) {
      linkShapeObserver?.unobserve(element);
      observedLinkShapes.delete(element);
    }
  }
}

/** Re-measure every observed link card. The ResizeObserver only fires on the
 *  card's own box, not on content changes, so this is triggered when preview
 *  metadata loads (image/title appear) to grow cards to their real height. */
function refitAllLinkShapes() {
  for (const [element, id] of observedLinkShapes) {
    if (element.isConnected) {
      fitLinkShapeHeight(id, linkCardContentHeight(element as HTMLElement));
    }
  }
}

function isGifSrc(src: string): boolean {
  return /\.gif($|\?)/i.test(src);
}

function resolveMediaSrc(src: string): string {
  return src.startsWith("/") ? `${window.location.origin}${src}` : src;
}

function toShape(
  id: string,
  source: Y.Map<unknown> | CanvasSerializedShape,
): CanvasShape {
  const read = (key: string) => (source instanceof Y.Map ? source.get(key) : source[key]);

  const typeValue = read("type");
  const type: CanvasShapeType = isCanvasShapeType(typeValue) ? typeValue : "note";
  const defaultSize = defaultSizeForShape(type);
  const minSize = minSizeForShape(type);
  const src =
    typeof read("src") === "string" ? resolveMediaSrc(String(read("src"))) : undefined;
  return {
    id,
    type,
    x: toNumber(read("x"), 0),
    y: toNumber(read("y"), 0),
    width: Math.max(minSize.width, toNumber(read("width"), defaultSize.width)),
    height: Math.max(minSize.height, toNumber(read("height"), defaultSize.height)),
    rotation: normalizeRotation(toNumber(read("rotation"), 0)),
    fontScale: clampFontScale(toNumber(read("fontScale"), 1)),
    text: typeof read("text") === "string" ? String(read("text")) : "",
    color:
      typeof read("color") === "string"
        ? String(read("color"))
        : defaultColorForShape(type),
    src,
    alt: typeof read("alt") === "string" ? String(read("alt")) : undefined,
    docAddress: legacyDocumentAddress({
      docAddress: read("docAddress"),
      docId: read("docId"),
      docSpaceId: read("docSpaceId"),
      src,
    }),
    authorId: typeof read("authorId") === "string" ? String(read("authorId")) : undefined,
    locked: read("locked") === true || undefined,
    updatedAt: toNumber(read("updatedAt"), Date.now()),
  };
}

function toStroke(
  id: string,
  source: Y.Map<unknown> | CanvasStrokeSnapshot,
): CanvasStroke {
  return toCanvasStroke(id, source, transform.value.scale);
}

function syncShapesFromY() {
  let removedInvalid = false;
  for (const [id, value] of yShapes.entries()) {
    const shape = toShape(id, value);
    if (!isValidCanvasShape(shape)) {
      yShapes.delete(id);
      removedInvalid = true;
    }
  }

  shapes.value = [...yShapes.entries()]
    .map(([id, value]) => toShape(id, value))
    .filter(isValidCanvasShape)
    .sort((a, b) => {
      if (a.type === "section" && b.type !== "section") return -1;
      if (a.type !== "section" && b.type === "section") return 1;
      return a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
    });

  let pruned = false;
  for (const id of selectedShapeIds.value) {
    const source = yShapes.get(id);
    if (!source || toShape(id, source).locked) {
      selectedShapeIds.value.delete(id);
      pruned = true;
    }
  }
  if (pruned) selectedShapeIds.value = new Set(selectedShapeIds.value);
  if (removedInvalid) {
    if (isReady) scheduleSave();
    else savePrunedInvalidShapesWhenReady = true;
  }
}

function syncStrokesFromY() {
  strokes.value = [...yStrokes.entries()]
    .map(([id, value]) => toStroke(id, value))
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  let pruned = false;
  for (const id of selectedStrokeIds.value) {
    const source = yStrokes.get(id);
    if (!source || toStroke(id, source).locked) {
      selectedStrokeIds.value.delete(id);
      pruned = true;
    }
  }
  if (pruned) selectedStrokeIds.value = new Set(selectedStrokeIds.value);
  renderInk();
}

function createShapeMap(shape: CanvasSerializedShape) {
  const map = new Y.Map<unknown>();
  map.set("type", shape.type);
  map.set("x", shape.x);
  map.set("y", shape.y);
  // Font-scaled types (text) omit their box; the registry decides per type.
  if (shapePersistsSize(shape.type)) {
    map.set("width", shape.width);
    map.set("height", shape.height);
  }
  map.set("rotation", shape.rotation);
  if (typeof shape.fontScale === "number") map.set("fontScale", shape.fontScale);
  map.set("text", shape.text);
  map.set("color", shape.color);
  if (shape.src) map.set("src", resolveMediaSrc(shape.src));
  if (shape.alt) map.set("alt", shape.alt);
  if (shape.docAddress) map.set("docAddress", shape.docAddress);
  if (shape.authorId) map.set("authorId", shape.authorId);
  if (shape.locked) map.set("locked", true);
  map.set("updatedAt", shape.updatedAt);
  return map;
}

function serializeShape(shape: CanvasShape): CanvasSerializedShape {
  return serializeCanvasShape(shape);
}

function serializeSnapshot(): string {
  const snapshot: CanvasSnapshot = {
    version: 1,
    shapes: shapes.value.map(serializeShape),
    strokes: strokes.value.map((stroke) => ({
      id: stroke.id,
      points: stroke.points.map(cloneFreehandPoint),
      style: { ...stroke.style },
      kind: stroke.kind,
      rotation: stroke.rotation,
      authorId: stroke.authorId,
      locked: stroke.locked,
      updatedAt: stroke.updatedAt,
    })),
  };
  return JSON.stringify(snapshot);
}

function dispatchSaveStatus() {
  window.dispatchEvent(
    new CustomEvent("save-status-changed", {
      detail: { status: saveState.value },
    }),
  );
}

async function manualSave() {
  if (!isReady) return;
  saveState.value = "saving";
  dispatchSaveStatus();

  try {
    const content = serializeSnapshot();
    if (props.documentId) {
      const response = await fetch(
        `/api/v1/spaces/${props.spaceId}/documents/${props.documentId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (!response.ok) throw new Error(await response.text());
    } else {
      await saveDocument(content);
    }

    saveState.value = "saved";
    dispatchSaveStatus();
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      if (saveState.value === "saved") {
        saveState.value = "idle";
        dispatchSaveStatus();
      }
    }, 1600);
  } catch (err) {
    saveState.value = "idle";
    toast.error(err instanceof Error ? err.message : String(err));
    dispatchSaveStatus();
  }
}

function scheduleSave() {
  if (!isReady) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void manualSave();
  }, 1200);
}

function saveImmediately() {
  if (!isReady) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  void manualSave();
}

let cachedViewportRect: DOMRect | null = null;

function screenPoint(event: MouseEvent) {
  const rect = cachedViewportRect;
  return {
    x: event.clientX - (rect?.left ?? 0),
    y: event.clientY - (rect?.top ?? 0),
  };
}

const transform = computed(() =>
  buildTransform(camera.value, screen.value, FIT_REFERENCE),
);

// The canvas moves shapes by transforming the viewport, which fires no
// scroll/resize event — so the fixed-position formatting toolbar won't follow
// on its own. Re-anchor it after each transform is painted (flush: "post" so
// the editor DOM reflects the new position when we read its coords).
watch(transform, () => canvasToolbarRef.value?.reposition(), { flush: "post" });

const canvasCursorCache = new Map<string, string>();
function makeCanvasCursor(color: string): string {
  if (typeof document === "undefined") return "default";
  const cached = canvasCursorCache.get(color);
  if (cached) return cached;

  const size = 18;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "default";
  ctx.scale(0.56, 0.56);

  const path = new Path2D(
    "M5.1 4.8a1.2 1.2 0 0 1 1.53-1.54l20.4 8.28a1.2 1.2 0 0 1-.14 2.26l-7.81 2.01a2.4 2.4 0 0 0-1.72 1.72l-2.01 7.81a1.2 1.2 0 0 1-2.26.14z",
  );

  ctx.shadowColor = "rgba(15, 23, 42, 0.25)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.shadowColor = "transparent";
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = "white";
  ctx.lineJoin = "round";
  ctx.stroke(path);

  const result = `url("${canvas.toDataURL()}") 3 3, default`;
  canvasCursorCache.set(color, result);
  return result;
}

// Panning (middle/right-drag) shows the grabbing hand; otherwise the canvas uses
// a local colored cursor that matches the color broadcast to collaborators.
const viewportCursor = computed(() => {
  if (isPanning.value) return "grabbing";
  return makeCanvasCursor(cursorColor.value);
});

function screenToWorld(point: { x: number; y: number }) {
  return viewportScreenToWorld(point.x, point.y, transform.value);
}

function worldToScreen(point: { x: number; y: number }) {
  return viewportWorldToScreen(point.x, point.y, transform.value);
}

// Cached CSS variable values — read once at mount and on theme change.
// getComputedStyle().getPropertyValue() forces a style recalc so we must
// not call it per-frame.
let cssGridMajor = "rgba(15, 23, 42, 0.13)";
let cssGridMinor = "rgba(15, 23, 42, 0.07)";
let cssInkColor = FREEHAND_STYLE.color;
let cssSectionTitleText = "#1e3a8a";

function canvasCssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  const source = viewportRef.value ?? document.documentElement;
  return getComputedStyle(source).getPropertyValue(name).trim() || fallback;
}

function refreshCssVars() {
  cssGridMajor = canvasCssVar("--canvas-grid-major", "rgba(15, 23, 42, 0.13)");
  cssGridMinor = canvasCssVar("--canvas-grid-minor", "rgba(15, 23, 42, 0.07)");
  cssInkColor = canvasCssVar("--canvas-ink-color", FREEHAND_STYLE.color);
  cssSectionTitleText = canvasCssVar("--canvas-section-title-text", "#1e3a8a");
}

function resolveDarkMode() {
  if (typeof window === "undefined") return false;
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function updateThemeMode() {
  isDarkMode.value = resolveDarkMode();
  void nextTick(renderThemeChanged);
}

function renderThemeChanged() {
  refreshCssVars();
  renderGrid();
  renderSections();
  renderInk();
}

function applyGridType(value: unknown) {
  const next: GridType =
    value === "clean" || value === "dots" || value === "grid" ? value : "dots";
  if (next === gridType.value) return;
  gridType.value = next;
  renderGrid();
}

function defaultInkColor() {
  return cssInkColor;
}

function renderGrid() {
  const canvas = gridRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);

  if (gridType.value === "clean") return;

  if (gridType.value === "dots") {
    drawWorldDots(context, transform.value, screen.value, {
      size: 40,
      color: cssGridMajor,
      radius: 1.2,
      minScreenSpacing: 8,
    });
    return;
  }

  drawWorldGrid(context, transform.value, screen.value, {
    levels: [
      {
        size: 40,
        color: cssGridMinor,
        lineWidth: 1,
        minScreenSpacing: 8,
      },
      {
        size: 200,
        color: cssGridMajor,
        lineWidth: 1,
        minScreenSpacing: 24,
      },
    ],
  });
}

function sectionTitleSize(shape: CanvasShape) {
  const maxWidth = Math.max(1, shape.width * transform.value.scale);
  const title = shape.text || t("Section");
  // The canvas title uses the same 13px font and 8px horizontal padding as
  // the inline editor. This approximation is also used for its canvas hitbox.
  return {
    width: Math.min(maxWidth, Math.max(40, title.length * 8 + 16)),
    height: 22,
  };
}

// Sections are intentionally a dedicated canvas layer between the backdrop
// grid and all content layers. Unlike DOM shapes, they can never establish a
// stacking context above cards, media, strokes, or controls. The frame/title
// drawing lives on the section extension's paint() hook; the host owns the
// layer, ordering, and the geometry shared with hit-testing / the title editor.
function renderSections() {
  const canvas = sectionsRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);

  const paint = getCanvasElementExtension("section")?.paint;
  if (!paint) return;
  const helpers: CanvasPaintHelpers = {
    scale: transform.value.scale,
    dx: transform.value.dx,
    dy: transform.value.dy,
    t,
    sectionTitleColor: cssSectionTitleText,
    isEditingSectionTitle: (id) => editingSectionTitleId.value === id,
    sectionTitlePosition,
    sectionTitleSize,
  };
  for (const shape of sectionShapes.value) {
    paint(context, shape, helpers);
  }
}

// Returns the highest-quality already-loaded image for `src` across all tiers,
// used as a backdrop while the target tier is still decoding.
function getCachedFallback(src: string): HTMLImageElement | null {
  for (let i = IMAGE_RESIZE_TIERS.length - 1; i >= 0; i--) {
    const cached = imageCache.get(resizeImageUrl(src, IMAGE_RESIZE_TIERS[i]));
    if (cached instanceof HTMLImageElement) return cached;
  }
  const cached = imageCache.get(src);
  return cached instanceof HTMLImageElement ? cached : null;
}

function renderImages() {
  const canvas = imagesRef.value;
  const ctx = canvas?.getContext("2d");
  if (!canvas || !ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, screen.value.width, screen.value.height);

  const t = transform.value;
  for (const shape of visibleImageShapes.value) {
    if (shape.type !== "image" || !shape.src || isGifSrc(shape.src)) continue;
    const sx = shape.x * t.scale + t.dx;
    const sy = shape.y * t.scale + t.dy;
    const sw = shape.width * t.scale;
    const sh = shape.height * t.scale;
    if (sw <= 0 || sh <= 0) continue;

    // Physical pixel width the image occupies on screen — used to pick the
    // smallest resolution tier that still renders crisply.
    const targetPx = Math.ceil(sw * dpr);
    const tieredSrc = resizeImageUrl(shape.src, targetPx);

    const cached = imageCache.get(tieredSrc);
    if (!cached) {
      imageCache.set(tieredSrc, "loading");
      const img = new Image();
      img.src = tieredSrc;
      // decode() resolves after the image is fully decoded off the main thread,
      // so drawImage() never has to block to decode inline.
      img
        .decode()
        .then(() => {
          imageCache.set(tieredSrc, img);
          renderImages();
        })
        .catch(() => {
          imageCache.set(tieredSrc, "error");
          renderImages();
        });
    }

    // While the correctly-sized version is still loading, paint any lower-res
    // cached version so the image doesn't flash back to a placeholder on zoom.
    const displayImg =
      cached instanceof HTMLImageElement ? cached : getCachedFallback(shape.src);

    const centerX = sx + sw / 2;
    const centerY = sy + sh / 2;
    const angle = (shape.rotation * Math.PI) / 180;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(angle);
    if (!displayImg) {
      ctx.fillStyle = "rgba(128,128,128,0.15)";
      ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(displayImg, -sw / 2, -sh / 2, sw, sh);
    }
    ctx.restore();

    for (const selection of remoteCanvasImageSelections.value) {
      if (selection.bounds.id !== shape.id) continue;
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      ctx.strokeStyle = selection.cursorColor;
      ctx.lineWidth = 2;
      ctx.strokeRect(-sw / 2 - 2, -sh / 2 - 2, sw + 4, sh + 4);
      ctx.restore();
    }

    if (selectedShapeIds.value.has(shape.id)) {
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(angle);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2;
      ctx.strokeRect(-sw / 2 - 2, -sh / 2 - 2, sw + 4, sh + 4);
      ctx.restore();
    }
  }
}

let inkRafId: number | null = null;
function scheduleInkRender() {
  if (inkRafId !== null) return;
  inkRafId = requestAnimationFrame(() => {
    inkRafId = null;
    renderInk();
  });
}

let presenceRafId: number | null = null;
function schedulePresenceUpdate() {
  if (presenceRafId !== null) return;
  presenceRafId = requestAnimationFrame(() => {
    presenceRafId = null;
    updatePresence();
  });
}

function renderInk() {
  const canvas = inkRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  renderCanvasInk({
    context,
    dpr,
    screen: screen.value,
    transform: transform.value,
    strokes: strokes.value,
    activeStroke: activeFreehandStroke,
    snapGuides: activeSnapGuides,
    defaultInkColor: defaultInkColor(),
  });

  renderSelections();
}

function renderSelections() {
  const canvas = selectionRef.value;
  const context = canvas?.getContext("2d");
  if (!canvas || !context) return;

  renderCanvasSelections({
    context,
    dpr,
    screen: screen.value,
    transform: transform.value,
    strokes: strokes.value,
    selectedStrokeIds: selectedStrokeIds.value,
    remoteSelectedStrokeIds: remoteCanvasStrokeSelections.value,
    selectedShapeBounds: [...selectedShapeIds.value]
      .map((id) => shapesById.value.get(id))
      .filter((s) => s != null)
      .map(shapeBounds),
    remoteSelectedShapeBounds: remoteCanvasDomSelections.value.map((s) => ({
      x: s.bounds.x,
      y: s.bounds.y,
      width: s.bounds.width,
      height: s.bounds.height,
      rotation: s.bounds.rotation,
      type: s.bounds.type,
      color: s.cursorColor,
    })),
  });
}

function resize() {
  const rect = viewportRef.value?.getBoundingClientRect() ?? null;
  cachedViewportRect = rect;
  screen.value = {
    width: Math.max(1, Math.round(rect?.width ?? 1)),
    height: Math.max(1, Math.round(rect?.height ?? 1)),
  };
  dpr = window.devicePixelRatio || 1;
  const canvas = gridRef.value;
  if (canvas) {
    canvas.width = Math.round(screen.value.width * dpr);
    canvas.height = Math.round(screen.value.height * dpr);
    canvas.style.width = `${screen.value.width}px`;
    canvas.style.height = `${screen.value.height}px`;
  }
  const sections = sectionsRef.value;
  if (sections) {
    sections.width = Math.round(screen.value.width * dpr);
    sections.height = Math.round(screen.value.height * dpr);
    sections.style.width = `${screen.value.width}px`;
    sections.style.height = `${screen.value.height}px`;
  }
  const ink = inkRef.value;
  if (ink) {
    ink.width = Math.round(screen.value.width * dpr);
    ink.height = Math.round(screen.value.height * dpr);
    ink.style.width = `${screen.value.width}px`;
    ink.style.height = `${screen.value.height}px`;
  }
  const images = imagesRef.value;
  if (images) {
    images.width = Math.round(screen.value.width * dpr);
    images.height = Math.round(screen.value.height * dpr);
    images.style.width = `${screen.value.width}px`;
    images.style.height = `${screen.value.height}px`;
  }
  const selection = selectionRef.value;
  if (selection) {
    selection.width = Math.round(screen.value.width * dpr);
    selection.height = Math.round(screen.value.height * dpr);
    selection.style.width = `${screen.value.width}px`;
    selection.style.height = `${screen.value.height}px`;
  }
  renderGrid();
  renderSections();
  renderInk();
  renderImages();
}

function presenceState(): CanvasPresenceState {
  const cam = camera.value;
  // Use toRaw on reactive Sets/Maps to bypass per-element proxy overhead
  // when iterating — these are snapshot reads, not reactive dependencies.
  const rawIds = toRaw(selectedShapeIds.value);
  const rawStrokeIds = toRaw(selectedStrokeIds.value);
  const selectionIds: string[] = [];
  for (const id of rawIds) selectionIds.push(id);
  for (const id of rawStrokeIds) selectionIds.push(id);
  return {
    kind: "canvas",
    pointer: localPointer,
    cursorColor: cursorColor.value,
    view: { x: cam.centerX, y: cam.centerY, scale: cam.zoom },
    selectionIds,
    focusedNodeId: selectedShape.value?.id ?? null,
    activeTool: activeTool.value,
  };
}

function updatePresence() {
  emit("presence", [presenceState()]);
}

function insertionPointFromEvent(event?: DragEvent | PointerEvent) {
  if (event) return screenToWorld(screenPoint(event));
  if (localPointer) return localPointer;
  return screenToWorld({
    x: screen.value.width / 2,
    y: screen.value.height / 2,
  });
}

async function addMediaFile(file: File, at: { x: number; y: number }) {
  saveState.value = "saving";
  dispatchSaveStatus();

  // The progress/success/error toast is driven by the upload manager (via
  // createUploadedMediaShape); the canvas only owns the on-canvas placeholder.
  const placeholderId = addUploadPlaceholder(
    mediaTypeForFile(file) ?? "image",
    file.name || "file",
    at,
  );
  try {
    const shape = await createUploadedMediaShape(file, at, {
      spaceId: props.spaceId,
      documentId: props.documentId,
    });
    removeUploadPlaceholder(placeholderId);
    if (!shape) {
      saveState.value = "idle";
      dispatchSaveStatus();
      return;
    }
    yShapes.set(shape.id, createShapeMap(shape));
    selectOnlyShape(shape.id);
    activeTool.value = "select";
    saveState.value = "idle";
    dispatchSaveStatus();
  } catch (_err) {
    removeUploadPlaceholder(placeholderId);
    saveState.value = "idle";
    dispatchSaveStatus();
  }
}

function uploadCanvasMediaFile(file: File): Promise<string> {
  return uploadMediaFile(file, {
    spaceId: props.spaceId,
    documentId: props.documentId,
  });
}

async function addCanvasFile(file: File, at: { x: number; y: number }) {
  saveState.value = "saving";
  dispatchSaveStatus();

  const placeholderId = addUploadPlaceholder("file", file.name || "file", at);
  try {
    const shape = await createUploadedFileShape(file, at, {
      spaceId: props.spaceId,
      documentId: props.documentId,
    });
    removeUploadPlaceholder(placeholderId);
    if (!shape) {
      saveState.value = "idle";
      dispatchSaveStatus();
      return;
    }
    yShapes.set(shape.id, createShapeMap(shape));
    selectOnlyShape(shape.id);
    activeTool.value = "select";
    saveState.value = "idle";
    dispatchSaveStatus();
  } catch (_err) {
    removeUploadPlaceholder(placeholderId);
    saveState.value = "idle";
    dispatchSaveStatus();
  }
}

async function addDroppedCanvasFiles(
  media: File[],
  files: File[],
  at: { x: number; y: number },
) {
  let offset = 0;
  for (const file of media) {
    await addMediaFile(file, { x: at.x + offset, y: at.y + offset });
    offset += 24;
  }
  for (const file of files) {
    await addCanvasFile(file, { x: at.x + offset, y: at.y + offset });
    offset += 24;
  }
}

function setEmbeddedDocumentEditorRef(instance: unknown) {
  embeddedDocumentEditor.value = (instance as CanvasDocumentEditorEl | null) ?? null;
}

// Ends the host-owned inline-edit session, flushing the editor's html back into
// the read-only card's cached preview.
function stopEmbeddedDocumentEdit() {
  const editing = editingDocumentShape.value;
  if (!editing) return;
  const html = embeddedDocumentEditor.value?.getHtml();
  if (typeof html === "string") {
    documentLinks.setPreviewContent(editing.address, html);
  }
  editingDocumentShape.value = null;
}

// Stamps the active shape-library item at `at` as a regular freehand stroke,
// so it lives on the ink layer with the same selection, move, recolor, and
// undo behavior as drawn strokes.
function placeShapeStroke(at: { x: number; y: number }) {
  const item = getShapeLibraryItem(activeShapeId.value) ?? SHAPE_LIBRARY[0];
  const stroke = createShapeStroke(item, at, penColor.value);
  yStrokes.set(stroke.id, createStrokeMap(stroke));
  selectStroke(stroke.id, false);
  activeTool.value = "select";
}

function addShape(type: "note" | "text" | "section", at: { x: number; y: number }) {
  // The active swatch feeds the factory: notes/sections pick up their color
  // picker, text has no fill.
  const color =
    type === "note"
      ? noteColor.value
      : type === "section"
        ? sectionColor.value
        : undefined;
  const shape = getCanvasElementExtension(type)?.create?.(at, { color });
  if (!shape) return;
  yShapes.set(shape.id, createShapeMap(shape));
  selectOnlyShape(shape.id);
  activeTool.value = "select";
  if (type === "section") editingSectionTitleId.value = shape.id;
  nextTick(() => {
    const selector =
      type === "section"
        ? `[data-section-title="${shape.id}"]`
        : `.canvas-shape[data-shape-id="${shape.id}"] rich-text-editor`;
    const el = document.querySelector<HTMLElement>(selector);
    el?.focus();
    (el as HTMLInputElement | HTMLTextAreaElement | null)?.select?.();
  });
}

// Section title editing writes through here (a host-owned <input> overlay).
// Note/text editing is owned by their extensions via hostContext.setText.
function updateShapeText(shape: CanvasShape, text: string) {
  if (shape.locked) return;
  updateShape(shape.id, { text });
}

function isShapeInsideSection(shape: CanvasShape, section: CanvasShape) {
  if (shape.id === section.id) return false;
  const bounds = shapeAabb(shape);
  const sectionBounds = shapeAabb(section);
  return (
    bounds.x >= sectionBounds.x &&
    bounds.y >= sectionBounds.y &&
    bounds.x + bounds.width <= sectionBounds.x + sectionBounds.width &&
    bounds.y + bounds.height <= sectionBounds.y + sectionBounds.height
  );
}

function isPointInsideSection(point: FreehandPoint, section: CanvasShape) {
  const bounds = shapeAabb(section);
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x <= bounds.x + bounds.width &&
    point.y <= bounds.y + bounds.height
  );
}

function isStrokeInsideSection(stroke: CanvasStroke, section: CanvasShape) {
  return (
    stroke.points.length > 0 &&
    stroke.points.every((point) => isPointInsideSection(point, section))
  );
}

function getSectionContents(section: CanvasShape, includeImmovable = false) {
  return {
    shapes: shapes.value
      .filter(
        (shape) =>
          (includeImmovable || canMoveShape(shape)) &&
          isShapeInsideSection(shape, section),
      )
      .map((shape) => ({ id: shape.id, x: shape.x, y: shape.y })),
    strokes: strokes.value
      .filter(
        (stroke) =>
          (includeImmovable || canMoveStroke(stroke)) &&
          isStrokeInsideSection(stroke, section),
      )
      .map((stroke) => ({
        id: stroke.id,
        points: stroke.points.map(cloneFreehandPoint),
      })),
  };
}

function translateStroke(id: string, points: FreehandPoint[], dx: number, dy: number) {
  updateStrokePoints(
    id,
    points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy })),
  );
}

function updateStrokePoints(id: string, points: FreehandPoint[], rotation?: number) {
  const stroke = yStrokes.get(id);
  if (!stroke) return;
  const currentStroke = strokesById.value.get(id);
  if (currentStroke && !canMoveStroke(currentStroke)) return;
  stroke.set("updatedAt", Date.now());
  stroke.set("points", points.map(cloneFreehandPoint));
  if (rotation !== undefined) stroke.set("rotation", rotation);
}

function setNoteColor(color: string) {
  noteColor.value = color;
  if (selectedShape.value?.type === "note") {
    updateShape(selectedShape.value.id, { color });
  }
}

function setSectionColor(color: string) {
  sectionColor.value = color;
  if (selectedShape.value?.type === "section") {
    updateShape(selectedShape.value.id, { color });
  }
}

function pickShapeLibraryItem(item: CanvasShapeLibraryItem) {
  activeShapeId.value = item.id;
  activeTool.value = "shape";
  shapePopoverRef.value?.hide();
}

function setPenColor(color: string) {
  penColor.value = color;
  if (selectedStrokeIds.value.size === 0) return;

  ydoc.transact(() => {
    for (const id of selectedStrokeIds.value) {
      const stroke = yStrokes.get(id);
      if (!stroke) continue;
      const style = strokeStyleFromUnknown(stroke.get("style"));
      stroke.set("style", { ...style, color });
      stroke.set("updatedAt", Date.now());
    }
  });
}

function syncCursorColor(color = readCanvasCursorColor()) {
  cursorColor.value = color;
  updatePresence();
}

function handleCursorColorPreferenceChange(event: Event) {
  const color =
    event instanceof CustomEvent && typeof event.detail?.color === "string"
      ? event.detail.color
      : readCanvasCursorColor();
  syncCursorColor(color);
}

function handleStorageChange(event: StorageEvent) {
  if (event.key === CANVAS_CURSOR_COLOR_STORAGE_KEY) {
    syncCursorColor();
  }
}

// Fit a link shape's height to its rendered content (a generic preview card or
// a hydrated tweet) so nothing clips. Content height is deterministic per
// width, so collaborators converge on the same value and stop writing; a small
// threshold avoids churn from sub-pixel jitter, and we never fight an in-flight
// manual resize of the same shape.
function fitLinkShapeHeight(id: string, height: number) {
  if (!userCanEditDocuments.value) return;
  if (dragState?.shapeId === id) return;
  if (!Number.isFinite(height) || height <= 0) return;
  const shape = shapes.value.find((candidate) => candidate.id === id);
  if (!shape) return;
  if (!canMoveShape(shape)) return;
  // Don't fit until the preview has settled: a card measured while its metadata
  // (and image) is still loading would persist a too-small height that never
  // corrects, since the observer won't re-fire once the box is fixed.
  const preview = shape.src ? linkPreviews.previews.value.get(shape.src) : undefined;
  if (!preview || preview.status === "loading") return;
  const minHeight = minSizeForShape("link").height;
  const target = Math.max(minHeight, Math.round(height));
  if (Math.abs(target - shape.height) <= 2) return;
  updateShape(id, { height: target });
}

function updateShape(id: string, patch: Partial<Omit<CanvasShape, "id">>) {
  const shape = yShapes.get(id);
  if (!shape) return;
  const changesTransform =
    patch.x !== undefined ||
    patch.y !== undefined ||
    patch.width !== undefined ||
    patch.height !== undefined ||
    patch.rotation !== undefined ||
    patch.fontScale !== undefined;
  const currentShape = shapesById.value.get(id);
  if (changesTransform && currentShape && !canMoveShape(currentShape)) return;
  shape.set("updatedAt", Date.now());
  // Font-scaled types (text) never persist a width/height box.
  const persistsSize = shapePersistsSize(shape.get("type") as CanvasShapeType);
  for (const [key, value] of Object.entries(patch)) {
    if (!persistsSize && (key === "width" || key === "height")) continue;
    shape.set(key, value);
  }
}

function setShapeLocked(id: string, locked: boolean) {
  const shape = yShapes.get(id);
  if (!shape) return;
  shape.set("updatedAt", Date.now());
  if (locked) shape.set("locked", true);
  else shape.delete("locked");
}

function setStrokeLocked(id: string, locked: boolean) {
  const stroke = yStrokes.get(id);
  if (!stroke) return;
  stroke.set("updatedAt", Date.now());
  if (locked) stroke.set("locked", true);
  else stroke.delete("locked");
}

function lockSelectedElements() {
  if (selectedShapeIds.value.size === 0 && selectedStrokeIds.value.size === 0) return;
  const shapeIds = new Set(selectedShapeIds.value);
  const strokeIds = new Set(selectedStrokeIds.value);

  // A section acts as a container when it is locked: every element currently
  // inside its bounds becomes locked with it. Include all contents, including
  // elements that are already locked or user-scoped to someone else.
  for (const id of selectedShapeIds.value) {
    const section = shapesById.value.get(id);
    if (section?.type !== "section") continue;
    const contents = getSectionContents(section, true);
    for (const shape of contents.shapes) shapeIds.add(shape.id);
    for (const stroke of contents.strokes) strokeIds.add(stroke.id);
  }

  ydoc.transact(() => {
    for (const id of shapeIds) setShapeLocked(id, true);
    for (const id of strokeIds) setStrokeLocked(id, true);
  });
  clearSelection();
}

function unlockHoveredElement() {
  const element = hoveredLockedElement.value;
  if (!element) return;
  if (element.type === "shape") setShapeLocked(element.id, false);
  else setStrokeLocked(element.id, false);
  hoveredLockedElement.value = null;
}

function deleteSelectedShape() {
  if (selectedShapeIds.value.size === 0 && selectedStrokeIds.value.size === 0) return;
  ydoc.transact(() => {
    for (const id of selectedShapeIds.value) {
      if (!isShapeLocked(id)) yShapes.delete(id);
    }
    for (const id of selectedStrokeIds.value) {
      if (!isStrokeLocked(id)) yStrokes.delete(id);
    }
  });
  selectedShapeIds.value = new Set();
  selectedStrokeIds.value = new Set();
}

function startFreehand(event: PointerEvent) {
  const started = startCanvasDrawingStroke(event, screenToWorld(screenPoint(event)), {
    color: penColor.value,
    mode: drawStrokeMode.value,
    worldToScreenScale: transform.value.scale,
  });
  if (!started) return;

  clearSelection();
  drawingSession = started.session;
  activeFreehandStroke = started.stroke;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function finishFreehand(event: PointerEvent) {
  if (!drawingSession || drawingSession.pointerId !== event.pointerId) return;
  const finished = finishCanvasDrawingStroke(drawingSession);
  if (finished) {
    yStrokes.set(finished.id, createStrokeMap(finished));
  }
  drawingSession = null;
  activeFreehandStroke = null;
  renderInk();
}

// Snapshots the start positions of everything that should move with a shape
// drag: the whole current selection, plus the contents of any selected
// section. Strokes are deduped against section contents so a stroke that is
// both selected and inside a dragged section only moves once.
function buildShapeDragState(event: PointerEvent): Extract<DragState, { type: "shape" }> {
  const moveShapes = new Map<string, { id: string; x: number; y: number }>();
  const moveStrokes = new Map<string, { id: string; points: FreehandPoint[] }>();

  for (const id of selectedShapeIds.value) {
    const shape = shapesById.value.get(id);
    if (!shape || !canMoveShape(shape)) continue;
    moveShapes.set(shape.id, { id: shape.id, x: shape.x, y: shape.y });
    if (shape.type === "section") {
      const contents = getSectionContents(shape);
      for (const s of contents.shapes) if (!moveShapes.has(s.id)) moveShapes.set(s.id, s);
      for (const s of contents.strokes)
        if (!moveStrokes.has(s.id)) moveStrokes.set(s.id, s);
    }
  }
  for (const id of selectedStrokeIds.value) {
    if (moveStrokes.has(id)) continue;
    const stroke = strokesById.value.get(id);
    if (stroke && canMoveStroke(stroke)) {
      moveStrokes.set(id, { id, points: stroke.points.map(cloneFreehandPoint) });
    }
  }

  return {
    type: "shape",
    pointerId: event.pointerId,
    startPointer: screenToWorld(screenPoint(event)),
    shapes: [...moveShapes.values()],
    strokes: [...moveStrokes.values()],
  };
}

function startShapeDrag(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0) return;
  if (shape.locked) {
    event.preventDefault();
    return;
  }

  // Shift toggles membership and does not begin a drag.
  if (event.shiftKey) {
    toggleShapeSelection(shape.id);
    if (shape.type !== "text") event.preventDefault();
    return;
  }

  // Clicking a shape outside the current selection collapses to just it;
  // clicking one already inside keeps the selection so the whole group drags.
  if (!selectedShapeIds.value.has(shape.id)) {
    selectOnlyShape(shape.id);
  }

  if (!canMoveShape(shape)) {
    if (shape.type !== "text") event.preventDefault();
    return;
  }

  dragMoved = false;
  dragState = buildShapeDragState(event);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  if (shape.type !== "text") {
    event.preventDefault();
  }
}

function startShapeResize(shape: CanvasShape, event: PointerEvent) {
  if (event.button !== 0 || !canMoveShape(shape)) return;
  selectOnlyShape(shape.id);
  // Text auto-sizes to its content, so drive off its measured box.
  const bounds = shapeBounds(shape);
  const resizeMode = getCanvasElementExtension(shape.type)?.transform;
  const isText = resizeMode?.resize === "font";
  // Media locks its aspect ratio; text keeps it too so scaling its font stays
  // proportional. Notes and sections resize freely.
  const keepAspect = Boolean(resizeMode?.aspectLocked) || isText;
  dragState = {
    type: "resize",
    pointerId: event.pointerId,
    shapeId: shape.id,
    fixedTopLeft: rotatedShapeCorners(bounds)[0],
    minSize: minSizeForShape(shape.type),
    aspect: keepAspect && bounds.height > 0 ? bounds.width / bounds.height : undefined,
    isText,
    initialFontScale: shape.fontScale ?? 1,
    initial: {
      x: shape.x,
      y: shape.y,
      width: bounds.width,
      height: bounds.height,
      rotation: shape.rotation,
    },
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function startShapeRotation(shape: CanvasShape, event: PointerEvent) {
  const canRotate = getCanvasElementExtension(shape.type)?.transform.rotate ?? false;
  if (event.button !== 0 || !canRotate || !canMoveShape(shape)) return;
  selectOnlyShape(shape.id);
  const bounds = shapeBounds(shape);
  dragState = {
    type: "rotate",
    pointerId: event.pointerId,
    shapeId: shape.id,
    center: {
      x: shape.x + bounds.width / 2,
      y: shape.y + bounds.height / 2,
    },
    initial: {
      x: shape.x,
      y: shape.y,
      width: bounds.width,
      height: bounds.height,
      rotation: shape.rotation,
    },
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function startStrokeResize(stroke: CanvasStroke, event: PointerEvent) {
  if (event.button !== 0 || !canMoveStroke(stroke)) return;
  const bounds = strokeBounds(stroke);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
  dragState = {
    type: "stroke-resize",
    pointerId: event.pointerId,
    strokeId: stroke.id,
    fixedTopLeft: { x: bounds.x, y: bounds.y },
    startBounds: bounds,
    initialPoints: stroke.points.map(cloneFreehandPoint),
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function startStrokeRotation(stroke: CanvasStroke, event: PointerEvent) {
  if (event.button !== 0 || !canMoveStroke(stroke)) return;
  const bounds = strokeBounds(stroke);
  if (!bounds) return;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  dragState = {
    type: "stroke-rotate",
    pointerId: event.pointerId,
    strokeId: stroke.id,
    center,
    startRotation: rotationFromPointer(center, screenToWorld(screenPoint(event))),
    initialRotation: stroke.rotation ?? 0,
    initialPoints: stroke.points.map(cloneFreehandPoint),
  };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

function startPan(event: PointerEvent) {
  dragState = {
    type: "pan",
    pointerId: event.pointerId,
    startPointer: { x: event.clientX, y: event.clientY },
    startCamera: camera.value,
  };
  isPanning.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function startMarquee(event: PointerEvent, additive: boolean) {
  if (!additive) clearSelection();
  const start = screenPoint(event);
  dragState = {
    type: "marquee",
    pointerId: event.pointerId,
    additive,
    startScreen: start,
    baseShapeIds: new Set(selectedShapeIds.value),
    baseStrokeIds: new Set(selectedStrokeIds.value),
  };
  marqueeRect.value = { x: start.x, y: start.y, width: 0, height: 0 };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

// Recomputes the selection from the marquee rectangle. Sections must be fully
// enclosed to be picked up (a marquee inside a big section selects its
// contents, not the section); every other shape selects on intersection.
function applyMarqueeSelection(
  state: Extract<DragState, { type: "marquee" }>,
  rect: Rect,
) {
  const topLeft = screenToWorld({ x: rect.x, y: rect.y });
  const bottomRight = screenToWorld({ x: rect.x + rect.width, y: rect.y + rect.height });
  const worldRect: Rect = {
    x: Math.min(topLeft.x, bottomRight.x),
    y: Math.min(topLeft.y, bottomRight.y),
    width: Math.abs(bottomRight.x - topLeft.x),
    height: Math.abs(bottomRight.y - topLeft.y),
  };

  const shapeIds = new Set(state.additive ? state.baseShapeIds : []);
  for (const shape of shapes.value) {
    if (shape.locked) continue;
    const bounds = shapeAabb(shape);
    const hit =
      shape.type === "section"
        ? rectContains(worldRect, bounds)
        : rectsIntersect(worldRect, bounds);
    if (hit) shapeIds.add(shape.id);
  }

  const strokeIds = new Set(state.additive ? state.baseStrokeIds : []);
  for (const stroke of strokes.value) {
    if (stroke.locked) continue;
    if (stroke.points.some((point) => isPointInRect(point, worldRect))) {
      strokeIds.add(stroke.id);
    }
  }

  selectedShapeIds.value = shapeIds;
  selectedStrokeIds.value = strokeIds;
  renderInk();
}

// Hit-tests canvas-rendered (non-GIF) image shapes in reverse paint order.
function hitTestImageShape(worldPoint: { x: number; y: number }): CanvasShape | null {
  for (let i = shapes.value.length - 1; i >= 0; i--) {
    const shape = shapes.value[i];
    if (shape.type !== "image" || isGifSrc(shape.src ?? "")) continue;
    if (pointInRotatedShape(worldPoint, shape)) return shape;
  }
  return null;
}

function sectionLocalPoint(worldPoint: { x: number; y: number }, shape: CanvasShape) {
  const center = {
    x: shape.x + shape.width / 2,
    y: shape.y + shape.height / 2,
  };
  const local = rotateVector(
    { x: worldPoint.x - center.x, y: worldPoint.y - center.y },
    -shape.rotation,
  );
  return { x: local.x + shape.width / 2, y: local.y + shape.height / 2 };
}

// Sections remain click-through in their interior. Only their painted border
// can be grabbed, preserving access to content placed inside them.
function hitTestSectionBorder(worldPoint: { x: number; y: number }): CanvasShape | null {
  const edgeWidth = 6;
  for (let i = sectionShapes.value.length - 1; i >= 0; i--) {
    const shape = sectionShapes.value[i];
    const local = sectionLocalPoint(worldPoint, shape);
    const inExpandedBounds =
      local.x >= -edgeWidth &&
      local.x <= shape.width + edgeWidth &&
      local.y >= -edgeWidth &&
      local.y <= shape.height + edgeWidth;
    const onEdge =
      local.x <= edgeWidth ||
      local.x >= shape.width - edgeWidth ||
      local.y <= edgeWidth ||
      local.y >= shape.height - edgeWidth;
    if (inExpandedBounds && onEdge) return shape;
  }
  return null;
}

function hitTestSectionTitle(worldPoint: { x: number; y: number }): CanvasShape | null {
  const screenPoint = worldToScreen(worldPoint);
  for (let i = sectionShapes.value.length - 1; i >= 0; i--) {
    const shape = sectionShapes.value[i];
    const origin = sectionTitlePosition(shape);
    const local = rotateVector(
      { x: screenPoint.x - origin.x, y: screenPoint.y - origin.y },
      -shape.rotation,
    );
    const size = sectionTitleSize(shape);
    if (local.x >= 0 && local.x <= size.width && local.y >= 0 && local.y <= size.height) {
      return shape;
    }
  }
  return null;
}

function editSectionTitle(shape: CanvasShape) {
  if (shape.locked) return;
  selectOnlyShape(shape.id);
  editingSectionTitleId.value = shape.id;
  renderSections();
  void nextTick(() => {
    const input = viewportRef.value?.querySelector<HTMLInputElement>(
      `[data-section-title="${shape.id}"]`,
    );
    input?.focus();
    input?.select();
  });
}

function finishSectionTitleEditing() {
  if (!editingSectionTitleId.value) return;
  editingSectionTitleId.value = null;
  renderSections();
}

function isPointInRect(point: { x: number; y: number }, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function handleViewportPointerDown(event: PointerEvent) {
  if (event.pointerType === "touch" && !event.isPrimary) return;

  // Dismiss context menu on any tap outside of it (the menu itself stops
  // propagation with @pointerdown.stop so taps inside it don't reach here).
  if (contextMenuPos.value) {
    contextMenuPos.value = null;
    contextMenuInsertWorld = null;
    return;
  }

  // The handlers below call preventDefault(), which suppresses the browser's
  // default focus shift — so without this the canvas never holds focus and
  // copy/cut/paste events are never dispatched to it. Shape/text pointerdowns
  // use @pointerdown.stop, so this only fires for empty-canvas/stroke clicks
  // and won't pull focus out of a text shape being edited.
  viewportRef.value?.focus({ preventScroll: true });

  const point = screenPoint(event);
  localPointer = screenToWorld(point);

  if (event.button === 1 || event.button === 2) {
    startPan(event);
    event.preventDefault();
    return;
  }

  if (activeTool.value === "select") {
    const additive = event.shiftKey;
    const worldPoint = screenToWorld(point);

    const hitImage = hitTestImageShape(worldPoint);
    if (hitImage) {
      if (hitImage.locked) {
        event.preventDefault();
        return;
      }
      if (additive) {
        toggleShapeSelection(hitImage.id);
      } else if (!selectedShapeIds.value.has(hitImage.id)) {
        selectOnlyShape(hitImage.id);
      }
      if (!canMoveShape(hitImage)) {
        event.preventDefault();
        return;
      }
      dragMoved = false;
      dragState = buildShapeDragState(event);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    const hitStroke = hitTestCanvasStroke(
      strokes.value,
      worldPoint,
      transform.value.scale,
    );
    if (hitStroke) {
      if (isStrokeLocked(hitStroke)) {
        event.preventDefault();
        return;
      }
      // Match regular shapes: Shift only changes selection membership, while
      // a normal pointerdown selects the stroke and starts a drag for the
      // current stroke selection.
      if (additive) {
        selectStroke(hitStroke, true);
        event.preventDefault();
        return;
      }
      // Grabbing a stroke that's already part of the selection keeps the whole
      // group (including any selected shapes/text) so it all drags together;
      // grabbing an unselected stroke collapses to just it.
      if (!selectedStrokeIds.value.has(hitStroke)) {
        selectStroke(hitStroke, false);
      }
      const stroke = strokesById.value.get(hitStroke);
      if (!stroke || !canMoveStroke(stroke)) {
        event.preventDefault();
        return;
      }
      dragMoved = false;
      dragState = buildShapeDragState(event);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    const hitSectionTitle = hitTestSectionTitle(worldPoint);
    if (hitSectionTitle) {
      startShapeDrag(hitSectionTitle, event);
      return;
    }

    const hitSectionBorder = hitTestSectionBorder(worldPoint);
    if (hitSectionBorder) {
      startShapeDrag(hitSectionBorder, event);
      return;
    }

    // Empty space: touch leaves panning/zooming to the two-finger gesture
    // handler; mouse/pen drag-selects with a marquee.
    if (event.pointerType === "touch") {
      if (!additive) clearSelection();
      return;
    }
    startMarquee(event, additive);
    return;
  }

  if (activeTool.value === "draw") {
    startFreehand(event);
    return;
  }

  if (activeTool.value === "shape") {
    placeShapeStroke(screenToWorld(point));
    event.preventDefault();
    return;
  }

  if (
    activeTool.value === "note" ||
    activeTool.value === "text" ||
    activeTool.value === "section"
  ) {
    addShape(activeTool.value, screenToWorld(point));
  }
  event.preventDefault();
}

function handleViewportDoubleClick(event: MouseEvent) {
  // A double-click is an empty-canvas shortcut for text. A section title is
  // the exception: it opens that title for editing.
  if (activeTool.value === "draw") return;

  const point = screenPoint(event);
  const worldPoint = screenToWorld(point);
  const hitSectionTitle = hitTestSectionTitle(worldPoint);
  if (hitSectionTitle) {
    event.preventDefault();
    editSectionTitle(hitSectionTitle);
    return;
  }

  const target = event.target;
  if (
    target instanceof Element &&
    target.closest(".canvas-shape, .canvas-transform-controls, .canvas-context-menu")
  ) {
    return;
  }

  if (hitTestSectionBorder(worldPoint)) {
    return;
  }
  if (
    hitTestImageShape(worldPoint) ||
    hitTestCanvasStroke(strokes.value, worldPoint, transform.value.scale)
  ) {
    return;
  }

  event.preventDefault();
  addShape("text", worldPoint);
}

// World-space bounding box of everything moving in a shape drag, at its
// starting position. Stroke point extents are included so freehand selections
// snap by their drawn bounds too.
function movingGroupBounds(
  drag: Extract<DragState, { type: "shape" }>,
): WorldRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const moved of drag.shapes) {
    const shape = shapesById.value.get(moved.id);
    if (!shape) continue;
    const bounds = shapeAabb({ ...shape, x: moved.x, y: moved.y });
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  for (const stroke of drag.strokes) {
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Nudges the raw drag offset so the dragged group's edges/centers snap to the
// edges/centers of the shapes it isn't moving, and records the active guides
// for rendering. Returns the (possibly adjusted) offset. Holding Cmd bypasses
// snapping entirely.
function snapDragOffset(
  drag: Extract<DragState, { type: "shape" }>,
  dx: number,
  dy: number,
  disabled: boolean,
): { dx: number; dy: number } {
  const startBounds = movingGroupBounds(drag);
  if (disabled || !startBounds) {
    activeSnapGuides = [];
    return { dx, dy };
  }

  // Only snap to shapes near the dragged group. A canvas can hold hundreds of
  // elements, so building guides for all of them (and matching against each)
  // every pointermove gets expensive — restrict to a proximity window around
  // the group's current position with a cheap rect test first.
  const margin = SNAP_PROXIMITY_PX / transform.value.scale;
  const near: Rect = {
    x: startBounds.x + dx - margin,
    y: startBounds.y + dy - margin,
    width: startBounds.width + margin * 2,
    height: startBounds.height + margin * 2,
  };
  const movingIds = new Set(drag.shapes.map((moved) => moved.id));
  const targets: SnapTarget[] = shapes.value
    .filter((shape) => !movingIds.has(shape.id) && rectsIntersect(near, shapeAabb(shape)))
    .map((shape) => ({ id: shape.id, bounds: shapeAabb(shape) }));

  const guides = computeSnapGuides({
    camera: camera.value,
    screen: screen.value,
    fit: FIT_REFERENCE,
    targets,
  });

  const snap = snapRectToGuides({
    guides,
    bounds: { ...startBounds, x: startBounds.x + dx, y: startBounds.y + dy },
    threshold: SNAP_THRESHOLD_PX / transform.value.scale,
  });

  activeSnapGuides = snap.guides;
  return { dx: dx + snap.dx, dy: dy + snap.dy };
}

function lockedElementAtPointer(event: PointerEvent): LockedCanvasElement | null {
  const target = event.target;
  if (target instanceof Element) {
    const shapeElement = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
    const shapeId = shapeElement?.dataset.shapeId;
    if (shapeId) {
      return isShapeLocked(shapeId) ? { type: "shape", id: shapeId } : null;
    }
  }

  const rect = cachedViewportRect;
  if (
    !rect ||
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    return null;
  }

  const worldPoint = screenToWorld(screenPoint(event));
  const image = hitTestImageShape(worldPoint);
  if (image?.locked) return { type: "shape", id: image.id };

  const strokeId = hitTestCanvasStroke(strokes.value, worldPoint, transform.value.scale);
  if (strokeId && isStrokeLocked(strokeId)) return { type: "stroke", id: strokeId };

  const section = hitTestSectionTitle(worldPoint) ?? hitTestSectionBorder(worldPoint);
  if (section?.locked) return { type: "shape", id: section.id };
  return null;
}

function updateHoveredLockedElement(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Element && target.closest(".canvas-unlock-button")) return;

  const next = lockedElementAtPointer(event);
  const current = hoveredLockedElement.value;
  if (current?.type === next?.type && current?.id === next?.id) return;
  hoveredLockedElement.value = next;
}

function handlePointerMove(event: PointerEvent) {
  const point = screenPoint(event);
  localPointer = screenToWorld(point);
  updateHoveredLockedElement(event);

  if (drawingSession && drawingSession.pointerId === event.pointerId) {
    for (const coalesced of event.getCoalescedEvents()) {
      activeFreehandStroke = addCanvasDrawingPoint(
        drawingSession,
        coalesced,
        screenToWorld(screenPoint(coalesced)),
      );
    }
    scheduleInkRender();
    event.preventDefault();
    return;
  }

  if (!dragState || dragState.pointerId !== event.pointerId) {
    schedulePresenceUpdate();
    return;
  }

  if (dragState.type === "pan") {
    camera.value = panCameraByScreenDelta({
      camera: dragState.startCamera,
      screen: screen.value,
      fit: FIT_REFERENCE,
      dxPx: dragState.startPointer.x - event.clientX,
      dyPx: dragState.startPointer.y - event.clientY,
    });
    schedulePresenceUpdate();
    return;
  }

  if (dragState.type === "marquee") {
    const rect: Rect = {
      x: Math.min(dragState.startScreen.x, point.x),
      y: Math.min(dragState.startScreen.y, point.y),
      width: Math.abs(point.x - dragState.startScreen.x),
      height: Math.abs(point.y - dragState.startScreen.y),
    };
    marqueeRect.value = rect;
    applyMarqueeSelection(dragState, rect);
    schedulePresenceUpdate();
    return;
  }

  const world = screenToWorld(point);
  if (dragState.type === "resize") {
    const shape = shapesById.value.get(dragState.shapeId);
    if (!shape || !canMoveShape(shape)) return;
    const resized = resizeRotatedShapeFromBottomRight({
      fixedTopLeft: dragState.fixedTopLeft,
      pointer: world,
      rotation: dragState.initial.rotation,
      minSize: dragState.minSize,
      aspect: dragState.aspect,
    });
    if (dragState.isText) {
      // Text has no stored box; translate the drag into a proportional font
      // scale and let the node re-measure its own width/height. Top-left stays
      // put, so it grows toward the corner being dragged.
      const ratio =
        dragState.initial.width > 0 ? resized.width / dragState.initial.width : 1;
      const nextScale = clampFontScale((dragState.initialFontScale ?? 1) * ratio);
      updateShape(dragState.shapeId, {
        fontScale: Math.round(nextScale * 1000) / 1000,
      });
      return;
    }
    updateShape(dragState.shapeId, {
      x: Math.round(resized.x),
      y: Math.round(resized.y),
      width: Math.round(resized.width),
      height: Math.round(resized.height),
    });
    return;
  }

  if (dragState.type === "rotate") {
    const shape = shapesById.value.get(dragState.shapeId);
    if (!shape || !canMoveShape(shape)) return;
    const rawRotation = rotationFromPointer(dragState.center, world);
    const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
    updateShape(dragState.shapeId, { rotation: Math.round(rotation * 10) / 10 });
    return;
  }

  if (dragState.type === "stroke-resize") {
    const stroke = strokesById.value.get(dragState.strokeId);
    if (!stroke || !canMoveStroke(stroke)) return;
    const resized = resizeRotatedShapeFromBottomRight({
      fixedTopLeft: dragState.fixedTopLeft,
      pointer: world,
      rotation: 0,
      minSize: { width: 32, height: 32 },
    });
    const scaleX = resized.width / dragState.startBounds.width;
    const scaleY = resized.height / dragState.startBounds.height;
    updateStrokePoints(
      dragState.strokeId,
      dragState.initialPoints.map((point) => ({
        ...point,
        x: resized.x + (point.x - dragState.startBounds.x) * scaleX,
        y: resized.y + (point.y - dragState.startBounds.y) * scaleY,
      })),
    );
    return;
  }

  if (dragState.type === "stroke-rotate") {
    const stroke = strokesById.value.get(dragState.strokeId);
    if (!stroke || !canMoveStroke(stroke)) return;
    const rawRotation = rotationFromPointer(dragState.center, world);
    const rotation = event.shiftKey ? snapRotation(rawRotation) : rawRotation;
    const delta = ((rotation - dragState.startRotation + 540) % 360) - 180;
    updateStrokePoints(
      dragState.strokeId,
      dragState.initialPoints.map((point) => {
        const rotated = rotateVector(
          { x: point.x - dragState.center.x, y: point.y - dragState.center.y },
          delta,
        );
        return {
          ...point,
          x: dragState.center.x + rotated.x,
          y: dragState.center.y + rotated.y,
        };
      }),
      normalizeRotation(dragState.initialRotation + delta),
    );
    return;
  }

  const drag = dragState;
  // A few pixels of travel (in screen space) promotes this from a click to a
  // drag, so a click on a document card opens it instead of nudging it.
  if (
    !dragMoved &&
    Math.hypot(world.x - drag.startPointer.x, world.y - drag.startPointer.y) *
      transform.value.scale >
      3
  ) {
    dragMoved = true;
  }
  const { dx, dy } = snapDragOffset(
    drag,
    world.x - drag.startPointer.x,
    world.y - drag.startPointer.y,
    event.metaKey,
  );
  ydoc.transact(() => {
    for (const moved of drag.shapes) {
      const shape = shapesById.value.get(moved.id);
      if (!shape || !canMoveShape(shape)) continue;
      updateShape(moved.id, {
        x: Math.round(moved.x + dx),
        y: Math.round(moved.y + dy),
      });
    }
    for (const stroke of drag.strokes) {
      const currentStroke = strokesById.value.get(stroke.id);
      if (!currentStroke || !canMoveStroke(currentStroke)) continue;
      translateStroke(stroke.id, stroke.points, dx, dy);
    }
  });
  // Yjs shape edits don't trigger an ink redraw, so guides won't appear without
  // this explicit render.
  scheduleInkRender();
}

function handlePointerUp(event: PointerEvent) {
  finishFreehand(event);
  if (dragState?.pointerId === event.pointerId) {
    if (dragState.type === "marquee") marqueeRect.value = null;
    if (dragState.type === "pan") isPanning.value = false;
    if (activeSnapGuides.length > 0) {
      activeSnapGuides = [];
      renderInk();
    }
    // Height fitting is suppressed during a manual resize; once it ends, snap a
    // link card back to its content height for the new width.
    const resizedShapeId = dragState.type === "resize" ? dragState.shapeId : null;
    dragState = null;
    if (resizedShapeId) void nextTick(() => refitLinkShape(resizedShapeId));
  }
}

/** Re-measure a link card and fit its shape height (used after a manual resize,
 *  when the ResizeObserver is intentionally ignored). */
function refitLinkShape(id: string) {
  const element = viewportRef.value?.querySelector<HTMLElement>(
    `.canvas-shape-link[data-link-shape-id="${id}"]`,
  );
  if (element) fitLinkShapeHeight(id, linkCardContentHeight(element));
}

function cancelTransformDrag() {
  if (dragState?.type === "resize" || dragState?.type === "rotate") {
    const shape = shapesById.value.get(dragState.shapeId);
    if (shape && canMoveShape(shape)) {
      updateShape(dragState.shapeId, dragState.initial);
    }
  } else if (dragState?.type === "stroke-resize" || dragState?.type === "stroke-rotate") {
    const stroke = strokesById.value.get(dragState.strokeId);
    if (stroke && canMoveStroke(stroke)) {
      updateStrokePoints(
        dragState.strokeId,
        dragState.initialPoints,
        dragState.type === "stroke-rotate" ? dragState.initialRotation : undefined,
      );
    }
  } else {
    return false;
  }
  dragState = null;
  return true;
}

function handlePointerCancel(event: PointerEvent) {
  if (!dragState || dragState.pointerId !== event.pointerId) return;
  if (cancelTransformDrag()) return;
  if (dragState.type === "marquee") marqueeRect.value = null;
  if (dragState.type === "pan") isPanning.value = false;
  dragState = null;
  if (activeSnapGuides.length > 0) {
    activeSnapGuides = [];
    renderInk();
  }
}

function handlePointerLeave() {
  localPointer = null;
  hoveredLockedElement.value = null;
  updatePresence();
}

function handleDragOver(event: DragEvent) {
  const hasFiles = dragHasCanvasFiles(event.dataTransfer);
  if (!hasFiles && !dragHasDocumentLink(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) {
    // Document drags from the sidebar/palette advertise effectAllowed "move";
    // a mismatched "copy" dropEffect makes the browser reject the drop, so we
    // mirror "move" for those. OS file drops carry copy semantics.
    event.dataTransfer.dropEffect = hasFiles ? "copy" : "move";
  }
}

function handleDrop(event: DragEvent) {
  routeCanvasDrop(event, canvasInputContext);
}

function selectContextMenuTarget(event: MouseEvent) {
  const target = event.target;
  if (target instanceof Element) {
    const shapeElement = target.closest<HTMLElement>(".canvas-shape[data-shape-id]");
    const shapeId = shapeElement?.dataset.shapeId;
    if (shapeId) {
      if (isShapeLocked(shapeId)) clearSelection();
      else if (!selectedShapeIds.value.has(shapeId)) selectOnlyShape(shapeId);
      return;
    }
  }

  const worldPoint = screenToWorld(screenPoint(event));
  const image = hitTestImageShape(worldPoint);
  if (image) {
    if (image.locked) clearSelection();
    else if (!selectedShapeIds.value.has(image.id)) selectOnlyShape(image.id);
    return;
  }

  const strokeId = hitTestCanvasStroke(strokes.value, worldPoint, transform.value.scale);
  if (strokeId) {
    if (isStrokeLocked(strokeId)) clearSelection();
    else if (!selectedStrokeIds.value.has(strokeId)) selectStroke(strokeId, false);
    return;
  }

  const section = hitTestSectionTitle(worldPoint) ?? hitTestSectionBorder(worldPoint);
  if (section) {
    if (section.locked) clearSelection();
    else if (!selectedShapeIds.value.has(section.id)) selectOnlyShape(section.id);
    return;
  }

  clearSelection();
}

function handleContextMenu(event: MouseEvent) {
  // Always prevent the native context menu / iOS callout.
  event.preventDefault();
  if (!viewportRef.value) return;

  // Don't open the menu when the draw tool is active.
  if (activeTool.value === "draw") return;

  dragState = null;
  isPanning.value = false;
  selectContextMenuTarget(event);
  const rect = viewportRef.value.getBoundingClientRect();
  const pos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  contextMenuInsertWorld = screenToWorld(pos);
  contextMenuPos.value = pos;
}

async function pasteFromContextMenu() {
  const insertAt = contextMenuInsertWorld ?? insertionPointFromEvent();
  contextMenuPos.value = null;
  contextMenuInsertWorld = null;
  routeContextMenuPaste(await readSystemClipboard(), insertAt, canvasInputContext);
}

function uploadFromContextMenu() {
  const insertAt = contextMenuInsertWorld ?? insertionPointFromEvent();
  contextMenuPos.value = null;
  contextMenuInsertWorld = null;

  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;

  input.onchange = () => {
    const files = input.files;
    if (!files?.length) return;

    void addDroppedCanvasFiles(
      mediaFilesFromList(files),
      canvasFilesFromList(files),
      insertAt,
    );
  };

  input.click();
}

async function readSystemClipboard() {
  const result = { canvasJson: "", html: "", text: "" };

  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read().catch(() => []);
    for (const item of items) {
      for (const type of item.types) {
        if (type === CANVAS_CLIPBOARD_MIME && !result.canvasJson) {
          result.canvasJson = await item
            .getType(type)
            .then((blob) => blob.text())
            .catch(() => "");
        }
        if (type === "text/html" && !result.html) {
          result.html = await item
            .getType(type)
            .then((blob) => blob.text())
            .catch(() => "");
        }
        if (type === "text/plain" && !result.text) {
          result.text = await item
            .getType(type)
            .then((blob) => blob.text())
            .catch(() => "");
        }
      }
    }
  }

  if (!result.text) {
    result.text = (await navigator.clipboard?.readText().catch(() => "")) ?? "";
  }

  return result;
}

function collectSelection(): {
  shapes: CanvasSerializedShape[];
  strokes: CanvasStrokeSnapshot[];
} {
  const selShapes = shapes.value
    .filter((shape) => selectedShapeIds.value.has(shape.id) && !shape.locked)
    .map(serializeShape);
  const selStrokes = strokes.value
    .filter((stroke) => selectedStrokeIds.value.has(stroke.id) && !stroke.locked)
    .map((stroke) => ({
      id: stroke.id,
      points: stroke.points.map(cloneFreehandPoint),
      style: { ...stroke.style },
      kind: stroke.kind,
      rotation: stroke.rotation,
      authorId: stroke.authorId,
      locked: stroke.locked,
      updatedAt: stroke.updatedAt,
    }));
  return { shapes: selShapes, strokes: selStrokes };
}

function selectedCanvasClipboard(): CanvasClipboard | null {
  return createCanvasClipboard(collectSelection());
}

/** True when the user has a real text selection (let the browser copy that instead). */
function hasActiveTextSelection(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el?.closest("textarea, input, select, document-view")) return true;
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim());
}

// Native clipboard events are synchronous and land in the system clipboard, so
// copies work across documents, canvases, tabs, and spaces.
function handleCopy(event: ClipboardEvent) {
  if (hasActiveTextSelection(event.target)) return;
  const payload = selectedCanvasClipboard();
  if (!payload) return;
  const json = serializeCanvasClipboard(payload);
  event.preventDefault();
  event.clipboardData?.setData(CANVAS_CLIPBOARD_MIME, json);
  event.clipboardData?.setData(
    "text/html",
    canvasClipboardToDocumentHtml(payload, { includeMetadata: true }),
  );
  event.clipboardData?.setData("text/plain", canvasClipboardToPlainText(payload));
}

function handleCut(event: ClipboardEvent) {
  if (hasActiveTextSelection(event.target)) return;
  const payload = selectedCanvasClipboard();
  if (!payload) return;
  const json = serializeCanvasClipboard(payload);
  event.preventDefault();
  event.clipboardData?.setData(CANVAS_CLIPBOARD_MIME, json);
  event.clipboardData?.setData(
    "text/html",
    canvasClipboardToDocumentHtml(payload, { includeMetadata: true }),
  );
  event.clipboardData?.setData("text/plain", canvasClipboardToPlainText(payload));
  deleteSelectedShape();
}

function copySelectionToClipboard() {
  const payload = selectedCanvasClipboard();
  if (!payload) return;
  const html = canvasClipboardToDocumentHtml(payload, { includeMetadata: true });
  const text = canvasClipboardToPlainText(payload);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ])
      .catch(() => navigator.clipboard?.writeText(text).catch(() => {}));
    return;
  }
  navigator.clipboard?.writeText(text).catch(() => {});
}

function cutSelectionToClipboard() {
  const payload = selectedCanvasClipboard();
  if (!payload) return;
  const html = canvasClipboardToDocumentHtml(payload, { includeMetadata: true });
  const text = canvasClipboardToPlainText(payload);
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    navigator.clipboard
      .write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ])
      .catch(() => navigator.clipboard?.writeText(text).catch(() => {}));
  } else {
    navigator.clipboard?.writeText(text).catch(() => {});
  }
  deleteSelectedShape();
}

/**
 * Recreates clipboard shapes/strokes with fresh ids, translated so the group's
 * top-left lands at the insertion point. One transaction = one undo step.
 */
function pasteCanvasClipboard(
  payload: CanvasClipboard,
  at: { x: number; y: number },
): void {
  const xs = [
    ...payload.shapes.map((shape) => shape.x),
    ...payload.strokes.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...payload.shapes.map((shape) => shape.y),
    ...payload.strokes.flatMap((stroke) => stroke.points.map((point) => point.y)),
  ];
  if (xs.length === 0 || ys.length === 0) return;
  const dx = at.x - Math.min(...xs);
  const dy = at.y - Math.min(...ys);
  const now = Date.now();
  const pastedShapeIds = new Set<string>();
  const pastedStrokeIds = new Set<string>();

  ydoc.transact(() => {
    for (const shape of payload.shapes) {
      const id = `shape-${crypto.randomUUID()}`;
      pastedShapeIds.add(id);
      yShapes.set(
        id,
        createShapeMap({
          ...shape,
          id,
          x: Math.round(shape.x + dx),
          y: Math.round(shape.y + dy),
          // A pasted personal element belongs to the person who pasted it,
          // never the author of the source clipboard item.
          authorId: shape.authorId ? currentUserId.value : undefined,
          updatedAt: now,
        }),
      );
    }
    for (const stroke of payload.strokes) {
      const id = `stroke-${crypto.randomUUID()}`;
      pastedStrokeIds.add(id);
      yStrokes.set(
        id,
        createStrokeMap({
          id,
          points: stroke.points.map((point) => ({
            ...point,
            x: point.x + dx,
            y: point.y + dy,
          })),
          style: { ...stroke.style },
          kind: stroke.kind,
          rotation: stroke.rotation,
          authorId: stroke.authorId ? currentUserId.value : undefined,
          updatedAt: now,
        }),
      );
    }
  });

  selectedShapeIds.value = pastedShapeIds;
  selectedStrokeIds.value = pastedStrokeIds;
  activeTool.value = "select";
  renderInk();
}

function pasteDocumentClipboardShapes(nextShapes: CanvasShape[]): boolean {
  if (nextShapes.length === 0) return false;
  const pastedShapeIds = new Set<string>();

  ydoc.transact(() => {
    for (const shape of nextShapes) {
      pastedShapeIds.add(shape.id);
      yShapes.set(
        shape.id,
        createShapeMap({
          ...shape,
          updatedAt: Date.now(),
        }),
      );
    }
  });

  selectedShapeIds.value = pastedShapeIds;
  selectedStrokeIds.value = new Set();
  activeTool.value = "select";
  renderImages();
  return true;
}

async function addImageFromUrl(
  fetchUrl: string,
  originalUrl: string,
  at: { x: number; y: number },
) {
  let file: File;
  try {
    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) throw new Error("URL did not return an image");
    const blob = await response.blob();
    file = new File([blob], filenameFromUrl(originalUrl), { type: blob.type });
  } catch (err) {
    toast.error(
      `Could not fetch image: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  await addMediaFile(file, at);
}

// Imports a pasted Figma selection (HTML blob with figmeta + kiwi scene data).
function pasteFigma(html: string, at: { x: number; y: number }) {
  saveState.value = "saving";
  dispatchSaveStatus();
  void pasteFigmaClipboard(html, at, {
    uploadMediaFile: uploadCanvasMediaFile,
    insertShape: (shape) => yShapes.set(shape.id, createShapeMap(shape)),
  }).then((result) => {
    if (result.createdIds.length > 0) {
      selectedShapeIds.value = new Set(result.createdIds);
      activeTool.value = "select";
    }
    if (result.error) {
      toast.error(
        result.error instanceof Error ? result.error.message : String(result.error),
      );
    }
    saveState.value = "idle";
    dispatchSaveStatus();
  });
}

// Insertion primitives handed to the paste/drop router (inputs.ts). The router
// owns the recognition/ordering; the host owns these host-state-touching bits.
const canvasInputContext: CanvasInputContext = {
  insertionPoint: (event) => insertionPointFromEvent(event),
  isDocumentUrl: (url) => documentUrlPartsFromUrl(url) !== null,
  pasteCanvasClipboard: (payload, at) => pasteCanvasClipboard(payload, at),
  addDroppedFiles: (media, files, at) => {
    void addDroppedCanvasFiles(media, files, at);
  },
  insertDocumentUrl: (url, at) => {
    void insertDocumentLinkFromUrl(url, at);
  },
  insertDocumentRef: (ref, at) => documentLinks.insertDocumentLink(ref, at),
  insertImageUrl: (fetchUrl, originalUrl, at) => {
    void addImageFromUrl(fetchUrl, originalUrl, at);
  },
  insertLink: (url, at) => insertLinkShape(url, at),
  pasteRichHtml: (html, text, at) =>
    pasteDocumentClipboardShapes(
      documentClipboardToCanvasShapes(html.trim() ? { html, text, at } : { text, at }),
    ),
  pasteFigma: (html, at) => pasteFigma(html, at),
};

function handlePaste(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("textarea, input, select, document-view")) return;
  routeCanvasPaste(event, canvasInputContext);
}

// The canvas renders full-bleed behind the fixed navigation sidebar, so the
// left `inset` px of the viewport are occluded by the nav. Fit-to-view must
// frame content within the *visible* region instead of the full viewport.
function reservedSidebarWidth(): number {
  if (typeof window === "undefined") return 0;
  // Below the md breakpoint the sidebar is an overlay drawer and reserves no space.
  if (!window.matchMedia("(min-width: 768px)").matches) return 0;
  const rect = document.querySelector(".sidebar")?.getBoundingClientRect();
  return Math.max(0, rect?.right ?? 0);
}

function fitView(maxZoom = 5) {
  const xs = [
    ...shapes.value.flatMap((shape) => {
      const bounds = shapeAabb(shape);
      return [bounds.x, bounds.x + bounds.width];
    }),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.x)),
  ];
  const ys = [
    ...shapes.value.flatMap((shape) => {
      const bounds = shapeAabb(shape);
      return [bounds.y, bounds.y + bounds.height];
    }),
    ...strokes.value.flatMap((stroke) => stroke.points.map((point) => point.y)),
  ];

  const inset = reservedSidebarWidth();
  const baseScale = Math.min(
    screen.value.width / FIT_REFERENCE.width,
    screen.value.height / FIT_REFERENCE.height,
  );

  if (xs.length === 0 || ys.length === 0) {
    // Center the world origin within the visible region (right of the nav).
    camera.value = { centerX: -inset / (2 * baseScale), centerY: 0, zoom: 1 };
    return;
  }

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX + 160);
  const height = Math.max(1, maxY - minY + 160);
  // Fit the content into the visible width, not the full (occluded) viewport.
  const availableWidth = Math.max(1, screen.value.width - inset);
  const fitScale = Math.min(availableWidth / width, screen.value.height / height);
  const zoom = Math.max(0.25, Math.min(maxZoom, fitScale / baseScale));
  const appliedScale = baseScale * zoom;

  camera.value = {
    // Shift the camera left by half the inset so the content centers in the
    // visible region rather than the full viewport.
    centerX: (minX + maxX) / 2 - inset / (2 * appliedScale),
    centerY: (minY + maxY) / 2,
    zoom,
  };
}

// Centers the viewport on the document's content the first time it loads, so a
// saved canvas opens framed instead of pinned to world origin. Fires at most
// once: `isInitialContent` is false for the user's own first edit (Yjs origin
// null), which only disarms the one-shot rather than recentering their view.
let hasFitInitialView = false;
function fitInitialViewIfNeeded(isInitialContent: boolean) {
  if (hasFitInitialView || !isReady) return;
  if (shapes.value.length === 0 && strokes.value.length === 0) return;
  hasFitInitialView = true;
  // Frame the content but never magnify past 100% on load.
  if (isInitialContent) fitView(1);
}

const canUndo = ref(false);
const canRedo = ref(false);
function refreshUndoState() {
  canUndo.value = undoManager.canUndo();
  canRedo.value = undoManager.canRedo();
}

function undo() {
  if (undoManager.canUndo()) undoManager.undo();
}

function redo() {
  if (undoManager.canRedo()) undoManager.redo();
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  // document-view hosts the embedded document editor; shadow-DOM events
  // retarget to the host element, so closest() must match the host itself.
  if (target?.closest("textarea, input, select, document-view")) return;

  if (event.key === "Escape" && cancelTransformDrag()) {
    event.preventDefault();
    return;
  }

  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "s") {
    event.preventDefault();
    void manualSave();
    return;
  }

  // Undo / redo: Cmd/Ctrl+Z, redo via Cmd/Ctrl+Shift+Z or Ctrl+Y.
  if ((event.metaKey || event.ctrlKey) && key === "z") {
    event.preventDefault();
    if (event.shiftKey) redo();
    else undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && key === "y") {
    event.preventDefault();
    redo();
    return;
  }

  if (event.key === "Delete" || event.key === "Backspace") {
    deleteSelectedShape();
    return;
  }

  if (key === "v") activeTool.value = "select";
  if (key === "d") activeTool.value = "draw";
  if (key === "n") activeTool.value = "note";
  if (key === "t") activeTool.value = "text";
  if (key === "s") activeTool.value = "section";
  if (key === "r") activeTool.value = "shape";
  if (key === "f") fitView();
}

watch(
  shapes,
  () => {
    void nextTick(syncTextShapeObservers);
    void nextTick(syncLinkShapeObservers);
    renderSections();
    renderImages();
    renderSelections();
  },
  { flush: "post" },
);

watch(selectedShapeIds, (ids) => {
  if (
    editingSectionTitleId.value &&
    (ids.size !== 1 || !ids.has(editingSectionTitleId.value))
  ) {
    finishSectionTitleEditing();
  }
  renderImages();
  renderSelections();
  updatePresence();
});

// Inline document editing ends as soon as the card leaves the (single)
// selection — clicking the canvas, selecting another shape, or deleting the
// card all funnel through here and tear the editor (and its presence) down.
watch(selectedShapeIds, (ids) => {
  const editing = editingDocumentShape.value;
  if (!editing) return;
  if (ids.size !== 1 || !ids.has(editing.shapeId)) {
    stopEmbeddedDocumentEdit();
  }
});

watch(activeTool, (tool) => {
  if (tool !== "select") stopEmbeddedDocumentEdit();
});

watch(shapes, () => {
  const editing = editingDocumentShape.value;
  if (editing && !shapesById.value.has(editing.shapeId)) {
    stopEmbeddedDocumentEdit();
  }
  if (editingSectionTitleId.value && !shapesById.value.has(editingSectionTitleId.value)) {
    finishSectionTitleEditing();
  }
});

watch(selectedStrokeIds, () => {
  renderSelections();
  updatePresence();
});

watch(remoteCanvasDomSelections, () => {
  renderSelections();
});

watch(remoteCanvasStrokeSelections, () => {
  renderSelections();
});

watch(remoteCanvasImageSelections, () => {
  renderImages();
});

watch(
  () => documentData.value?.properties?.gridtype,
  (value) => applyGridType(value),
  { immediate: true },
);

const documentPreviewAddresses = computed(() =>
  [
    ...new Set(
      shapes.value
        .filter((shape) => shape.type === "document")
        .map(documentAddressForShape)
        .filter((address): address is string => Boolean(address)),
    ),
  ].sort(),
);

const linkPreviewUrls = computed(() =>
  [
    ...new Set(
      shapes.value
        .filter((shape) => shape.type === "link")
        .map((shape) => shape.src)
        .filter((url): url is string => Boolean(url)),
    ),
  ].sort(),
);

// Moving a card changes updatedAt and refreshes the shapes array. Watch a
// stable key of the actual preview inputs instead, so those visual edits never
// cause preview work. The loaders themselves remain responsible for caching.
watch(
  () => documentPreviewAddresses.value.join("\u001f"),
  () => {
    for (const address of documentPreviewAddresses.value) {
      void documentLinks.loadPreview({ address });
    }
  },
  { immediate: true },
);

watch(
  () => linkPreviewUrls.value.join("\u001f"),
  () => {
    for (const url of linkPreviewUrls.value) void linkPreviews.loadPreview(url);
  },
  { immediate: true },
);

// Once a preview loads, its card renders the image/title; re-measure so the
// shape grows to fit (the ResizeObserver alone won't catch content-only growth).
watch(linkPreviews.previews, () => {
  void nextTick(refitAllLinkShapes);
});

watch(
  () => [
    camera.value.centerX,
    camera.value.centerY,
    camera.value.zoom,
    screen.value.width,
    screen.value.height,
  ],
  () => {
    renderGrid();
    renderSections();
    renderInk();
    renderImages();
    updatePresence();
  },
  { flush: "post" },
);

onMounted(() => {
  void import("#editor/document.ts");
  refreshCssVars();
  yShapes.observeDeep((_events, transaction) => {
    syncShapesFromY();
    // Persist only this client's own edits (local edits have origin null; undo/
    // redo carry the UndoManager origin). Remote changes are persisted by their
    // originator — the peer that made them, or the server for agent edits — so
    // re-saving them here would mean every client rewrites the doc on every
    // change, including the initial room state that arrives as "remote" on load.
    if (transaction.origin !== "remote" && transaction.origin !== "seed") scheduleSave();
    refreshUndoState();
    fitInitialViewIfNeeded(transaction.origin !== null);
  });
  yStrokes.observeDeep((_events, transaction) => {
    syncStrokesFromY();
    // Persist only this client's own edits (local edits have origin null; undo/
    // redo carry the UndoManager origin). Remote changes are persisted by their
    // originator — the peer that made them, or the server for agent edits — so
    // re-saving them here would mean every client rewrites the doc on every
    // change, including the initial room state that arrives as "remote" on load.
    if (transaction.origin !== "remote" && transaction.origin !== "seed") scheduleSave();
    refreshUndoState();
    fitInitialViewIfNeeded(transaction.origin !== null);
  });
  syncShapesFromY();
  syncStrokesFromY();
  void nextTick(syncTextShapeObservers);
  void nextTick(syncLinkShapeObservers);
  resize();

  viewportControls = createViewportControls({
    target: viewportRef.value ?? window,
    getCamera: () => camera.value,
    setCamera: (nextCamera) => {
      camera.value = nextCamera;
    },
    getScreen: () => screen.value,
    getFit: () => FIT_REFERENCE,
    onTouchGestureStart: () => {
      dragState = null;
      isPanning.value = false;
      drawingSession = null;
      activeFreehandStroke = null;
      renderInk();
    },
    minZoom: 0.15,
    maxZoom: 10,
  });

  resizeObserver = new ResizeObserver(resize);
  if (viewportRef.value) resizeObserver.observe(viewportRef.value);

  updateThemeMode();
  themeObserver = new MutationObserver(updateThemeMode);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  colorSchemeMedia.addEventListener("change", updateThemeMode);

  syncCursorColor();
  window.addEventListener(
    CANVAS_CURSOR_COLOR_CHANGE_EVENT,
    handleCursorColorPreferenceChange,
  );
  window.addEventListener("storage", handleStorageChange);

  updatePresence();
  isReady = true;
  if (savePrunedInvalidShapesWhenReady) {
    savePrunedInvalidShapesWhenReady = false;
    saveImmediately();
  }
  // If the room state already arrived before mount, frame it now that the
  // screen has been measured; otherwise the Yjs observer frames it on first
  // sync. Either way the first content to land counts as initial.
  fitInitialViewIfNeeded(true);
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerCancel);
  window.addEventListener("copy", handleCopy);
  window.addEventListener("cut", handleCut);
  window.addEventListener("paste", handlePaste);
});

onUnmounted(() => {
  viewportControls?.dispose();
  resizeObserver?.disconnect();
  textShapeObserver?.disconnect();
  observedTextShapes.clear();
  linkShapeObserver?.disconnect();
  observedLinkShapes.clear();
  themeObserver?.disconnect();
  colorSchemeMedia?.removeEventListener("change", updateThemeMode);
  emit("presence", []);
  undoManager.destroy();
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerCancel);
  window.removeEventListener("copy", handleCopy);
  window.removeEventListener("cut", handleCut);
  window.removeEventListener("paste", handlePaste);
  window.removeEventListener(
    CANVAS_CURSOR_COLOR_CHANGE_EVENT,
    handleCursorColorPreferenceChange,
  );
  window.removeEventListener("storage", handleStorageChange);
  imageCache.clear();
  if (saveTimer) clearTimeout(saveTimer);
  if (saveStateTimer) clearTimeout(saveStateTimer);
  if (cameraMoveTimer) clearTimeout(cameraMoveTimer);
  if (inkRafId !== null) cancelAnimationFrame(inkRafId);
  if (presenceRafId !== null) cancelAnimationFrame(presenceRafId);
});
</script>

<template>
  <div class="canvas-root" :class="{ 'is-dark': isDarkMode }">
    <div
      v-if="
        activeTool === 'draw' ||
        activeTool === 'note' ||
        activeTool === 'section' ||
        activeTool === 'shape' ||
        selectedStrokeIds.size > 0 ||
        selectedShape?.type === 'note' ||
        selectedShape?.type === 'section'
      "
      class="canvas-sub-toolbar"
      @pointerdown.stop
    >
      <span
        v-if="activeTool === 'draw'"
        class="canvas-draw-modes"
        :aria-label="t('Draw mode')"
      >
        <button
          v-for="mode in DRAW_STROKE_MODES"
          :key="mode.id"
          type="button"
          class="canvas-draw-mode"
          :class="{ active: drawStrokeMode === mode.id }"
          :aria-label="t(mode.label)"
          :aria-pressed="drawStrokeMode === mode.id"
          :title="t(mode.label)"
          @click="drawStrokeMode = mode.id"
        >
          <div
            class="svg-icon canvas-draw-mode-icon"
            aria-hidden="true"
            v-html="mode.icon"
          />
        </button>
      </span>
      <span v-if="activeTool === 'draw'" class="canvas-divider"></span>
      <span
        v-if="activeTool === 'note' || selectedShape?.type === 'note'"
        class="canvas-note-colors"
        :aria-label="t('Note color')"
      >
        <button
          v-for="color in NOTE_COLORS"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: (selectedShape?.type === 'note' ? selectedShape.color : noteColor) === color }"
          :style="{ background: color }"
          :aria-label="`${t('Set note color')} ${color}`"
          @click="setNoteColor(color)"
        ></button>
      </span>
      <span
        v-if="activeTool === 'section' || selectedShape?.type === 'section'"
        class="canvas-note-colors"
        :aria-label="`${t('Section')} color`"
      >
        <button
          v-for="color in SECTION_COLORS"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: (selectedShape?.type === 'section' ? selectedShape.color : sectionColor) === color }"
          :style="{ background: color }"
          :aria-label="`${t('Section')} color ${color}`"
          @click="setSectionColor(color)"
        ></button>
      </span>
      <span
        v-if="
          (activeTool === 'draw' || activeTool === 'shape' || selectedStrokeIds.size > 0) &&
          (activeTool === 'note' ||
            selectedShape?.type === 'note' ||
            activeTool === 'section' ||
            selectedShape?.type === 'section')
        "
        class="canvas-divider"
      ></span>
      <span
        v-if="activeTool === 'draw' || activeTool === 'shape' || selectedStrokeIds.size > 0"
        class="canvas-note-colors"
        :aria-label="t('Pen color')"
      >
        <button
          v-for="color in PEN_COLORS"
          :key="color"
          type="button"
          class="canvas-color-swatch"
          :class="{ active: (selectedStrokeIds.size > 0 ? selectedStrokeColor : penColor) === color }"
          :style="{ background: color }"
          :aria-label="`${t('Set pen color')} ${color}`"
          @click="setPenColor(color)"
        ></button>
      </span>
    </div>
    <div class="canvas-toolbar" @pointerdown.stop>
      <button
        v-for="tool in CANVAS_TOOLS"
        :key="tool.id"
        type="button"
        class="canvas-tool"
        :class="{ active: activeTool === tool.id }"
        :aria-label="t(tool.label)"
        :aria-pressed="activeTool === tool.id"
        :data-tooltip="`${t(tool.label)} · ${tool.shortcut}`"
        @click="activeTool = tool.id"
      >
        <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="tool.icon" />
      </button>
      <a-popover-trigger ref="shapePopoverRef" class="canvas-shape-trigger">
        <button
          slot="trigger"
          type="button"
          class="canvas-tool"
          :class="{ active: activeTool === 'shape' }"
          :aria-label="t('Shape')"
          :aria-pressed="activeTool === 'shape'"
          :data-tooltip="`${t('Shape')} · R`"
        >
          <div
            class="svg-icon canvas-tool-icon"
            aria-hidden="true"
            v-html="canvasShapeIcon"
          />
        </button>
        <a-popover placements="top">
          <div class="canvas-shape-popover" @pointerdown.stop>
            <div class="canvas-shape-popover-panel">
              <button
                v-for="item in SHAPE_LIBRARY"
                :key="item.id"
                type="button"
                class="canvas-shape-option"
                :class="{ active: activeTool === 'shape' && activeShapeId === item.id }"
                :aria-label="t(item.label)"
                @click="pickShapeLibraryItem(item)"
              >
                <div
                  class="svg-icon canvas-shape-option-icon"
                  aria-hidden="true"
                  v-html="item.icon"
                />
                <span class="canvas-shape-option-label">{{ t(item.label) }}</span>
              </button>
            </div>
          </div>
        </a-popover>
      </a-popover-trigger>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Undo')"
        :data-tooltip="`${t('Undo')} · ⌘Z`"
        :disabled="!canUndo"
        @click="undo"
      >
        <div
          class="svg-icon canvas-tool-icon"
          aria-hidden="true"
          v-html="undoArrowIcon"
        />
      </button>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Redo')"
        :data-tooltip="`${t('Redo')} · ⌘⇧Z`"
        :disabled="!canRedo"
        @click="redo"
      >
        <div
          class="svg-icon canvas-tool-icon"
          aria-hidden="true"
          v-html="redoArrowIcon"
        />
      </button>
      <span class="canvas-divider"></span>
      <button
        type="button"
        class="canvas-tool"
        :aria-label="t('Fit to view')"
        :data-tooltip="`${t('Fit to view')} · F`"
        @click="fitView()"
      >
        <div
          class="svg-icon canvas-tool-icon"
          aria-hidden="true"
          v-html="canvasFitViewIcon"
        />
      </button>
    </div>

    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <div
      ref="viewportRef"
      class="canvas-viewport"
      tabindex="-1"
      :style="{ cursor: viewportCursor }"
      @contextmenu="handleContextMenu"
      @pointerdown="handleViewportPointerDown"
      @pointercancel="handlePointerCancel"
      @pointerleave="handlePointerLeave"
      @dblclick="handleViewportDoubleClick"
      @dragover="handleDragOver"
      @drop="handleDrop"
    >
      <canvas ref="gridRef" class="canvas-grid"></canvas>
      <canvas ref="sectionsRef" class="canvas-sections"></canvas>
      <canvas ref="imagesRef" class="canvas-images"></canvas>
      <canvas ref="inkRef" class="canvas-ink"></canvas>
      <canvas ref="selectionRef" class="canvas-selection"></canvas>
      <div
        class="canvas-world"
        :style="{
          transform: `translate(${transform.dx}px, ${transform.dy}px) scale(${transform.scale})`,
        }"
      >
        <article
          v-for="shape in domShapes"
          :key="shape.id"
          class="canvas-shape"
          :class="[
            shape.type,
            { selected: selectedShapeIds.has(shape.id) },
          ]"
          :style="{
            left: `${shape.x}px`,
            top: `${shape.y}px`,
            ...(shape.type === 'text'
              ? { '--canvas-text-font-size': `${TEXT_BASE_FONT_PX * (shape.fontScale ?? 1)}px` }
              : { width: `${shape.width}px`, height: `${shape.height}px` }),
            transform: `rotate(${shape.rotation}deg)`,
            ...(shape.type === 'image' ? {} : { background: shape.color }),
          }"
          :data-shape-id="shape.id"
        >
          <!-- Extension-owned custom element (note, text, …). Falls back to the
               inline branches below for types not yet migrated. -->
          <component
            :is="elementTagForShape(shape)"
            v-if="elementTagForShape(shape)"
            :shape.prop="shape"
            :context.prop="hostContext"
            :data.prop="elementDataForShape(shape)"
            @request-drag="startShapeDrag(shape, ($event as CustomEvent).detail)"
            @document-click="onElementActivate(shape, ($event as CustomEvent).detail)"
            @open-document="onElementOpen(shape, $event)"
          />
          <!-- elementTagForShape returns null for exactly two cases the host
               renders directly (they depend on host state the registry loop
               doesn't carry): a document card being edited inline, and a
               Twitter/X embed. Both are custom elements. -->
          <template v-else>
            <canvas-document-editor
              v-if="shape.type === 'document' && editingDocumentShape?.shapeId === shape.id"
              :ref="setEmbeddedDocumentEditorRef"
              class="canvas-shape-document-editor"
              :space-id="props.spaceId"
              :document-id="editingDocumentShape.documentId"
              :title="documentLinks.shapeTitle(shape)"
              :toggle-task-index="editingDocumentShape.toggleTaskIndex"
              @drag-start="startShapeDrag(shape, ($event as CustomEvent).detail[0])"
              @exit-edit="stopEmbeddedDocumentEdit"
            ></canvas-document-editor>
            <div
              v-else-if="
              shape.type === 'link' &&
              shape.src &&
              linkPreviews.previewForShape(shape)?.metadata?.embed?.provider === 'twitter'
            "
              class="canvas-twitter-shape"
              @pointerdown.stop="startShapeDrag(shape, $event)"
              @wheel.stop
            >
              <canvas-twitter-embed
                :value.prop="linkPreviews.previewForShape(shape)!.metadata!.embed!.html"
                @embed-resize="fitLinkShapeHeight(shape.id, ($event as CustomEvent).detail)"
              ></canvas-twitter-embed>
            </div>
          </template>
        </article>

        <!-- Local upload placeholders shown until each dropped/pasted file finishes uploading. -->
        <div
          v-for="placeholder in uploadPlaceholders"
          :key="placeholder.id"
          class="canvas-upload-placeholder"
          :style="{
            left: `${placeholder.x}px`,
            top: `${placeholder.y}px`,
            width: `${placeholder.width}px`,
            height: `${placeholder.height}px`,
          }"
        >
          <div class="canvas-upload-spinner" aria-hidden="true"></div>
          <div class="canvas-upload-name">{{ placeholder.filename }}</div>
        </div>
      </div>

      <div
        v-if="editingSectionShape"
        class="canvas-section-title-overlay"
        :style="{
          left: `${sectionTitlePosition(editingSectionShape).x}px`,
          top: `${sectionTitlePosition(editingSectionShape).y}px`,
          width: `${Math.max(1, editingSectionShape.width * transform.scale)}px`,
          transform: `rotate(${editingSectionShape.rotation}deg)`,
          '--canvas-section-color': editingSectionShape.color,
        }"
        @pointerdown.stop
      >
        <input
          class="canvas-section-title"
          :data-section-title="editingSectionShape.id"
          :value="editingSectionShape.text"
          spellcheck="false"
          :aria-label="t('Section headline')"
          @focus="selectOnlyShape(editingSectionShape.id)"
          @pointerdown.stop
          @dblclick.stop
          @input="updateShapeText(editingSectionShape, ($event.target as HTMLInputElement).value)"
          @blur="finishSectionTitleEditing"
        >
      </div>

      <div v-if="selectedTransformShape" class="canvas-transform-controls">
        <button
          type="button"
          class="canvas-transform-handle canvas-rotate-handle"
          :aria-label="`${t('Rotate')} ${selectedTransformShape.type}`"
          :style="{
            left: `${transformControlPositions(selectedTransformShape).rotation.x}px`,
            top: `${transformControlPositions(selectedTransformShape).rotation.y}px`,
          }"
          @pointerdown.stop="startShapeRotation(selectedTransformShape, $event)"
        >
          ↻
        </button>
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} ${selectedTransformShape.type}`"
          :style="{
            left: `${transformControlPositions(selectedTransformShape).resize.x}px`,
            top: `${transformControlPositions(selectedTransformShape).resize.y}px`,
            transform: `translate(-50%, -50%) rotate(${selectedTransformShape.rotation}deg)`,
          }"
          @pointerdown.stop="startShapeResize(selectedTransformShape, $event)"
        ></button>
      </div>
      <div v-if="selectedResizableDocument" class="canvas-transform-controls">
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} document`"
          :style="{
            left: `${transformControlPositions(selectedResizableDocument).resize.x}px`,
            top: `${transformControlPositions(selectedResizableDocument).resize.y}px`,
            transform: `translate(-50%, -50%) rotate(${selectedResizableDocument.rotation}deg)`,
          }"
          @pointerdown.stop="startShapeResize(selectedResizableDocument, $event)"
        ></button>
      </div>
      <div v-if="selectedResizableSection" class="canvas-transform-controls">
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} ${t('Section')}`"
          :style="{
            left: `${transformControlPositions(selectedResizableSection).resize.x}px`,
            top: `${transformControlPositions(selectedResizableSection).resize.y}px`,
          }"
          @pointerdown.stop="startShapeResize(selectedResizableSection, $event)"
        ></button>
      </div>
      <div
        v-if="selectedBasicShapeStroke && selectedBasicShapeStrokeControls"
        class="canvas-transform-controls"
      >
        <button
          type="button"
          class="canvas-transform-handle canvas-rotate-handle"
          :aria-label="`${t('Rotate')} ${t('Shape')}`"
          :style="{
            left: `${selectedBasicShapeStrokeControls.rotation.x}px`,
            top: `${selectedBasicShapeStrokeControls.rotation.y}px`,
          }"
          @pointerdown.stop="startStrokeRotation(selectedBasicShapeStroke, $event)"
        >
          ↻
        </button>
        <button
          type="button"
          class="canvas-transform-handle canvas-resize-handle"
          :aria-label="`${t('Resize')} ${t('Shape')}`"
          :style="{
            left: `${selectedBasicShapeStrokeControls.resize.x}px`,
            top: `${selectedBasicShapeStrokeControls.resize.y}px`,
            transform: `translate(-50%, -50%) rotate(${selectedBasicShapeStroke.rotation || 0}deg)`,
          }"
          @pointerdown.stop="startStrokeResize(selectedBasicShapeStroke, $event)"
        ></button>
      </div>

      <button
        v-if="hoveredLockedElementPosition"
        type="button"
        class="canvas-unlock-button"
        :aria-label="t('Unlock')"
        :data-tooltip="t('Unlock')"
        :style="{
          transform: `translate(${hoveredLockedElementPosition.x}px, ${hoveredLockedElementPosition.y}px) translate(-50%, -50%)`,
        }"
        @pointerdown.stop
        @click.stop="unlockHoveredElement"
      >
        <div class="svg-icon" aria-hidden="true" v-html="unlockIcon" />
      </button>

      <div
        v-for="presence in remoteCanvasPointerPresences"
        :key="presence.clientId"
        class="canvas-presence"
        :class="{ 'is-instant': isCameraMoving }"
        :style="{
          transform: `translate(${worldToScreen(presence.state!.pointer!).x}px, ${worldToScreen(presence.state!.pointer!).y}px)`,
          '--presence-color':
            presence.state!.cursorColor ||
            presence.user.color ||
            getPresenceColor(presence.user.id),
        }"
      >
        <svg
          class="canvas-presence-cursor"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4.5 4.2a.6.6 0 0 1 .77-.77l13.2 5.36a.6.6 0 0 1-.07 1.13l-5.05 1.3a1.6 1.6 0 0 0-1.15 1.15l-1.3 5.05a.6.6 0 0 1-1.13.07z"
            fill="var(--presence-color)"
            stroke="#fff"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
        <span class="canvas-presence-label">{{ presence.user.name }}</span>
      </div>

      <div
        v-if="marqueeRect"
        class="canvas-marquee"
        :style="{
          left: `${marqueeRect.x}px`,
          top: `${marqueeRect.y}px`,
          width: `${marqueeRect.width}px`,
          height: `${marqueeRect.height}px`,
        }"
      ></div>

      <div
        v-if="contextMenuPos"
        class="canvas-context-menu"
        :style="{
          transform: `translate(${contextMenuPos.x}px, ${contextMenuPos.y}px)`,
        }"
        @pointerdown.stop
      >
        <template v-if="selectedShapeIds.size > 0 || selectedStrokeIds.size > 0">
          <button
            type="button"
            class="canvas-tool"
            :aria-label="t('Lock')"
            @click="lockSelectedElements(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="lockIcon" />
          </button>
          <span class="canvas-divider"></span>
          <button
            type="button"
            class="canvas-tool"
            :aria-label="t('Copy')"
            @click="copySelectionToClipboard(); contextMenuPos = null"
          >
            <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="copyIcon" />
          </button>
          <button
            type="button"
            class="canvas-tool"
            :aria-label="t('Cut')"
            @click="cutSelectionToClipboard(); contextMenuPos = null"
          >
            <div
              class="svg-icon canvas-tool-icon"
              aria-hidden="true"
              v-html="scissorsIcon"
            />
          </button>
          <span class="canvas-divider"></span>
        </template>
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Paste')"
          @click="pasteFromContextMenu"
        >
          <div
            class="svg-icon canvas-tool-icon"
            aria-hidden="true"
            v-html="clipboardDocumentIcon"
          />
        </button>
        <button
          type="button"
          class="canvas-tool"
          :aria-label="t('Upload file')"
          @click="uploadFromContextMenu"
        >
          <div class="svg-icon canvas-tool-icon" aria-hidden="true" v-html="uploadIcon" />
        </button>
        <template v-if="selectedShapeIds.size > 0 || selectedStrokeIds.size > 0">
          <span class="canvas-divider"></span>
          <button
            type="button"
            class="canvas-tool danger"
            :aria-label="t('Delete')"
            @click="deleteSelectedShape(); contextMenuPos = null"
          >
            <div
              class="svg-icon canvas-tool-icon"
              aria-hidden="true"
              v-html="trashIcon"
            />
          </button>
        </template>
      </div>
    </div>

    <document-toolbar ref="canvasToolbarRef" variant="canvas" standalone />
  </div>
</template>

<!--
  Not scoped: element bodies (note handle, audio grip, link/pdf/document cards,
  …) are built imperatively inside the canvas-* custom elements, so they don't
  carry Vue's scope attribute and scoped rules would never match them. Every
  selector here is .canvas-* prefixed and canvas-specific, so global scope is
  safe. (Future cleanup: extract the element-body rules to a stylesheet
  co-located with the element modules.)
-->
<style>
.canvas-root {
  --canvas-bg: var(--color-neutral-50);
  --canvas-text: var(--color-neutral-900);
  --canvas-muted: #6b7280;
  --canvas-strong: #374151;
  --canvas-toolbar-bg: rgba(255, 255, 255, 0.94);
  --canvas-toolbar-border: #d1d5db;
  --canvas-toolbar-shadow: rgba(15, 23, 42, 0.14);
  --canvas-tool-text: #374151;
  --canvas-tool-hover-bg: #f3f4f6;
  --canvas-tool-active-bg: #dbeafe;
  --canvas-tool-active-border: #bfdbfe;
  --canvas-tool-active-text: #1d4ed8;
  --canvas-divider-color: #e5e7eb;
  --canvas-grid-minor: rgba(15, 23, 42, 0.07);
  --canvas-grid-major: rgba(15, 23, 42, 0.13);
  --canvas-ink-color: #111827;
  --canvas-shape-border: rgba(15, 23, 42, 0.14);
  --canvas-shape-shadow: rgba(15, 23, 42, 0.12);
  --canvas-handle-bg: rgba(15, 23, 42, 0.08);
  --canvas-section-bg: rgba(219, 234, 254, 0.08);
  --canvas-section-border: rgba(37, 99, 235, 0.55);
  --canvas-section-title-bg: #eff6ff;
  --canvas-section-title-focus-bg: #ffffff;
  --canvas-section-title-border: rgba(37, 99, 235, 0.28);
  --canvas-section-title-text: #1e3a8a;
  --canvas-image-bg: #ffffff;
  --canvas-doc-bg: #ffffff;
  --canvas-doc-accent: #2563eb;
  --canvas-doc-divider: #e5e7eb;
  --canvas-doc-content: #374151;
  --canvas-link-bg: #ffffff;
  --canvas-link-border: rgba(15, 23, 42, 0.14);
  --canvas-link-title: #111827;
  --canvas-link-domain: #6b7280;
  --canvas-link-desc: #6b7280;
  --canvas-resize-border: rgba(15, 23, 42, 0.45);
  --canvas-presence-text: #111827;
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--canvas-bg);
  color: var(--canvas-text);
}

@media (prefers-color-scheme: dark) {
  .canvas-root {
    --canvas-muted: #9ca3af;
    --canvas-strong: #e5e7eb;
    --canvas-toolbar-bg: rgba(24, 24, 27, 0.94);
    --canvas-toolbar-border: rgba(255, 255, 255, 0.12);
    --canvas-toolbar-shadow: rgba(0, 0, 0, 0.38);
    --canvas-tool-text: #d1d5db;
    --canvas-tool-hover-bg: rgba(255, 255, 255, 0.08);
    --canvas-tool-active-bg: rgba(37, 99, 235, 0.26);
    --canvas-tool-active-border: rgba(96, 165, 250, 0.48);
    --canvas-tool-active-text: #bfdbfe;
    --canvas-divider-color: rgba(255, 255, 255, 0.12);
    --canvas-grid-minor: rgba(255, 255, 255, 0.07);
    --canvas-grid-major: rgba(255, 255, 255, 0.13);
    --canvas-ink-color: #f3f4f6;
    --canvas-shape-border: rgba(255, 255, 255, 0.16);
    --canvas-shape-shadow: rgba(0, 0, 0, 0.32);
    --canvas-handle-bg: rgba(255, 255, 255, 0.12);
    --canvas-section-bg: rgba(96, 165, 250, 0.09);
    --canvas-section-border: rgba(147, 197, 253, 0.62);
    --canvas-section-title-bg: #172033;
    --canvas-section-title-focus-bg: #111827;
    --canvas-section-title-border: rgba(147, 197, 253, 0.36);
    --canvas-section-title-text: #dbeafe;
    --canvas-image-bg: #111827;
    --canvas-doc-bg: #1a1d24;
    --canvas-doc-accent: #93c5fd;
    --canvas-doc-divider: rgba(255, 255, 255, 0.1);
    --canvas-doc-content: #d1d5db;
    --canvas-link-bg: #1a1d24;
    --canvas-link-border: rgba(255, 255, 255, 0.12);
    --canvas-link-title: #f3f4f6;
    --canvas-link-domain: #9ca3af;
    --canvas-link-desc: #9ca3af;
    --canvas-resize-border: rgba(255, 255, 255, 0.58);
    --canvas-presence-text: #111827;
  }
}

.canvas-toolbar {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: calc(100% - 24px);
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 12px;
  background: var(--canvas-toolbar-bg);
  padding: 6px;
  box-shadow: 0 10px 28px var(--canvas-toolbar-shadow);
  backdrop-filter: blur(8px);
}

.canvas-sub-toolbar {
  position: absolute;
  bottom: 74px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 11;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 24px);
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 12px;
  background: var(--canvas-toolbar-bg);
  padding: 6px;
  box-shadow: 0 8px 22px var(--canvas-toolbar-shadow);
  backdrop-filter: blur(8px);
}

.canvas-tool {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  padding: 0;
  color: var(--canvas-tool-text);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.canvas-tool:disabled {
  opacity: 0.35;
  cursor: default;
}

.canvas-tool-icon {
  width: 20px;
  height: 20px;
}

.canvas-tool:hover:not(:disabled) {
  background: var(--canvas-tool-hover-bg);
  color: var(--canvas-text);
}

.canvas-tool.active,
.canvas-tool.primary {
  border-color: var(--canvas-tool-active-border);
  background: var(--canvas-tool-active-bg);
  color: var(--canvas-tool-active-text);
}

.canvas-tool.danger {
  color: #b91c1c;
}

.canvas-tool:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.canvas-divider {
  width: 1px;
  height: 24px;
  background: var(--canvas-divider-color);
}

.canvas-shape-trigger {
  display: inline-flex;
}

/* The popover content is portaled to the document root, outside .canvas-root,
   so it cannot use the --canvas-* variables and carries its own colors. */
.canvas-shape-popover {
  width: max-content;
  padding-bottom: 8px;
  transition: opacity 0.12s ease;
}

.canvas-shape-popover-panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 150px;
  border: 1px solid #d1d5db;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.94);
  padding: 6px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.14);
  backdrop-filter: blur(8px);
}

.canvas-shape-option {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  padding: 7px 10px;
  color: #374151;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.canvas-shape-option:hover {
  background: #f3f4f6;
}

.canvas-shape-option.active {
  border-color: #bfdbfe;
  background: #dbeafe;
  color: #1d4ed8;
}

.canvas-shape-option-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

@media (prefers-color-scheme: dark) {
  .canvas-shape-popover-panel {
    border-color: rgba(255, 255, 255, 0.12);
    background: rgba(24, 24, 27, 0.94);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
  }

  .canvas-shape-option {
    color: #d1d5db;
  }

  .canvas-shape-option:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .canvas-shape-option.active {
    border-color: rgba(96, 165, 250, 0.48);
    background: rgba(37, 99, 235, 0.26);
    color: #bfdbfe;
  }
}

.canvas-unlock-button {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 9;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 999px;
  background: var(--canvas-toolbar-bg);
  padding: 0;
  color: var(--canvas-tool-text);
  box-shadow: 0 3px 10px var(--canvas-toolbar-shadow);
  cursor: pointer;
}

.canvas-unlock-button .svg-icon {
  width: 15px;
  height: 15px;
}

.canvas-unlock-button:hover {
  background: var(--canvas-tool-hover-bg);
  color: var(--canvas-text);
}

.canvas-unlock-button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.canvas-context-menu {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 10px;
  background: var(--canvas-toolbar-bg);
  padding: 4px;
  box-shadow: 0 6px 18px var(--canvas-toolbar-shadow);
  backdrop-filter: blur(8px);
  pointer-events: auto;
  will-change: transform;
  /* Offset slightly below and to the right of the long-press point. */
  translate: 8px 8px;
}

.canvas-note-colors {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: 2px;
}

.canvas-draw-modes {
  display: flex;
  align-items: center;
  border: 1px solid var(--canvas-toolbar-border);
  border-radius: 8px;
  padding: 2px;
}

.canvas-draw-mode {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 0;
  color: var(--canvas-tool-text);
  cursor: pointer;
}

.canvas-draw-mode-icon {
  width: 18px;
  height: 18px;
}

.canvas-draw-mode:hover {
  background: var(--canvas-tool-hover-bg);
  color: var(--canvas-text);
}

.canvas-draw-mode.active {
  background: var(--canvas-tool-active-bg);
  color: var(--canvas-tool-active-text);
}

.canvas-color-swatch {
  width: 22px;
  height: 22px;
  border: 1px solid rgba(15, 23, 42, 0.18);
  border-radius: 999px;
  cursor: pointer;
}

.canvas-color-swatch.active {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}

.canvas-viewport {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background-color: var(--canvas-bg);
  touch-action: none;
  /* Prevent iOS long-press from selecting text in shape DOM nodes while drawing. */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  /* Focusable (tabindex) so the browser dispatches clipboard events here, but
     it's not a control — suppress the focus ring. */
  outline: none;
}

/* Re-enable text selection inside editable shape content. */
.canvas-section-title {
  -webkit-user-select: text;
  user-select: text;
}

.canvas-world {
  position: absolute;
  inset: 0;
  transform-origin: 0 0;
}

.canvas-grid,
.canvas-sections,
.canvas-images,
.canvas-ink,
.canvas-selection {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}

.canvas-shape {
  position: absolute;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--canvas-shape-border);
  border-radius: 8px;
  content-visibility: auto;
  transform-origin: center;
}

.canvas-upload-placeholder {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  border: 1px dashed var(--canvas-shape-border);
  border-radius: 8px;
  background: var(--canvas-image-bg);
  color: var(--color-text-secondary, #6b7280);
  pointer-events: none;
}

.canvas-upload-spinner {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2.5px solid var(--canvas-shape-border);
  border-top-color: var(--color-accent, #3b82f6);
  animation: canvas-upload-spin 0.7s linear infinite;
}

.canvas-upload-name {
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.2;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@keyframes canvas-upload-spin {
  to {
    transform: rotate(360deg);
  }
}

.canvas-shape.text {
  width: max-content;
  max-width: none;
  min-width: 32px;
  min-height: 40px;
  border-color: transparent;
  background: transparent !important;
  box-shadow: none;
}

.canvas-shape.image {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.canvas-shape.video {
  border-color: transparent;
  background: var(--canvas-image-bg);
}

.canvas-shape.file {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.canvas-shape.image .canvas-shape-image,
.canvas-shape.video .canvas-shape-image,
.canvas-shape.file .canvas-shape-file {
  cursor: move;
}

.canvas-shape.image .canvas-shape-image {
  width: 100%;
  height: 100%;
  background: transparent;
}

.canvas-shape-file {
  width: 100%;
  height: 100%;
  max-width: none;
  margin: 0;
}

.canvas-shape.audio {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

.canvas-shape-audio {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  overflow: hidden;
  border: 1px solid var(--canvas-doc-divider, #e5e7eb);
  border-radius: var(--radius-md);
  background: var(--canvas-toolbar-bg, #fff);
  box-shadow: 0 1px 3px rgb(15 23 42 / 12%);
}

.canvas-shape-audio-handle {
  flex: 0 0 auto;
  width: 16px;
  height: 100%;
  cursor: move;
  background-image: radial-gradient(currentcolor 1px, transparent 1px);
  background-position: center;
  background-size: 4px 4px;
  color: var(--canvas-text-muted, #9ca3af);
  opacity: 0.6;
}

.canvas-shape-audio-player {
  width: 100%;
  min-width: 0;
  height: 40px;
  flex: 1 1 auto;
}

.canvas-pdf-preview {
  display: flex;
  width: 100%;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--canvas-doc-divider, #e5e7eb);
  border-radius: var(--radius-md);
  background: #fff;
  box-shadow: 0 1px 3px rgb(15 23 42 / 12%);
}

.canvas-pdf-preview-header {
  min-width: 0;
  padding: 7px 10px;
  overflow: hidden;
  border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
  background: #f8fafc;
  color: var(--canvas-text, #111827);
  cursor: move;
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-pdf-preview-frame {
  display: block;
  width: 100%;
  min-height: 0;
  flex: 1;
  border: 0;
  background: #fff;
}

.canvas-shape-handle {
  height: 18px;
  flex: 0 0 auto;
  cursor: move;
  background: var(--canvas-handle-bg);
}

.canvas-shape.document {
  background: var(--canvas-doc-bg) !important;
  cursor: move;
}

.canvas-shape-document {
  width: 100%;
  height: 100%;
  cursor: move;
}

.canvas-shape-document-editor {
  width: 100%;
  height: 100%;
}

/* Body of the <canvas-document-editor> custom element (was the scoped styles of
   CanvasDocumentEditor.vue). Descendant-scoped under .canvas-doc-editor so the
   generic child class names don't leak now that the block is global. */
.canvas-doc-editor {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  cursor: auto;
  color: var(--canvas-text, #111827);
  font: inherit;
}

.canvas-doc-editor .editor-header {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  gap: 10px;
  border-bottom: 1px solid var(--canvas-doc-divider, #e5e7eb);
  padding: 10px 12px;
  cursor: move;
}

.canvas-doc-editor .icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  color: var(--canvas-doc-accent, #2563eb);
}

.canvas-doc-editor .title-wrap {
  min-width: 0;
  flex: 1 1 auto;
}

.canvas-doc-editor .title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.2;
}

.canvas-doc-editor .done {
  flex: 0 0 auto;
  border: 0;
  border-radius: 6px;
  background: var(--canvas-doc-accent, #2563eb);
  padding: 4px 10px;
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}

.canvas-doc-editor .editor-body {
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
  padding: 12px 14px 16px;
  scrollbar-width: thin;
}

.canvas-doc-editor .editor-body document-view {
  display: block;
  min-width: 0;
}

.canvas-doc-editor .editor-hint {
  margin: 0;
  color: var(--canvas-muted, #6b7280);
  font-size: 13px;
  line-height: 1.4;
}

.canvas-shape.link {
  background: var(--canvas-link-bg) !important;
  cursor: move;
}

.canvas-shape-link {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  cursor: move;
}

.canvas-twitter-shape {
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--canvas-link-bg);
  cursor: move;
}

/* Container built inside the <canvas-twitter-embed> custom element. */
.canvas-twitter-embed {
  display: flex;
  width: 100%;
  height: 100%;
  justify-content: center;
  overflow: hidden;
}

.canvas-link-image {
  flex: none;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--canvas-handle-bg);
}

.canvas-link-image img,
.canvas-link-image video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.canvas-link-body {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  min-height: 0;
  overflow: hidden;
}

.canvas-link-site {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.canvas-link-favicon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  object-fit: contain;
}

.canvas-link-domain {
  font-size: 11px;
  color: var(--canvas-link-domain);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.canvas-link-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--canvas-link-title);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.canvas-link-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--canvas-link-desc);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.canvas-section-title-overlay {
  position: absolute;
  z-index: 6;
  display: flex;
  cursor: move;
  pointer-events: auto;
  transform-origin: 0 0;
}

.canvas-section-title {
  box-sizing: border-box;
  field-sizing: content;
  max-width: 100%;
  border: 1px solid
    color-mix(in srgb, var(--canvas-section-color, #60a5fa) 48%, transparent);
  border-radius: 6px;
  background: color-mix(
    in srgb,
    var(--canvas-section-color, #60a5fa) 10%,
    var(--canvas-toolbar-bg)
  );
  padding: 3px 8px;
  color: var(--canvas-text);
  font: inherit;
  font-size: 13px;
  font-weight: 750;
  line-height: 1.2;
  outline: none;
}

.canvas-section-title:focus {
  border-color: var(--canvas-section-color, #60a5fa);
  background: var(--canvas-toolbar-bg);
}

.canvas-shape-image {
  display: block;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  object-fit: contain;
  background: var(--canvas-image-bg);
  user-select: none;
}

.canvas-shape-textwrap {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  --editor-padding: 0.25rem;
  color: var(--canvas-text);
  font-size: 15px;
  line-height: 1.35;
}

/* Text shapes auto-size to their content via TipTap's natural height. */
.canvas-shape.text .canvas-shape-textwrap {
  display: block;
  width: max-content;
  max-width: none;
  cursor: move;
  font-size: var(--canvas-text-font-size, 15px);
  --editor-white-space: pre-wrap;
  --editor-word-break: normal;
  --editor-overflow-wrap: normal;
}

.canvas-shape.note .canvas-shape-textwrap {
  color: #111827;
}

.canvas-transform-controls {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
}

.canvas-transform-handle {
  position: absolute;
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--canvas-resize-border);
  cursor: nwse-resize;
  font-size: 20px;
  font-weight: 500;
  line-height: 1;
  text-shadow: 0 1px 2px var(--canvas-toolbar-shadow);
  pointer-events: auto;
  transform: translate(-50%, -50%);
}

.canvas-transform-handle:hover {
  color: #1d4ed8;
}

.canvas-transform-handle:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.canvas-rotate-handle {
  cursor: grab;
  font-size: 21px;
}

.canvas-rotate-handle:active {
  cursor: grabbing;
}

.canvas-resize-handle::before {
  position: absolute;
  top: 5px;
  left: 5px;
  width: 9px;
  height: 9px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  content: "";
}

.canvas-marquee {
  position: absolute;
  z-index: 7;
  border: 1px solid #2563eb;
  border-radius: 2px;
  background: rgba(37, 99, 235, 0.1);
  pointer-events: none;
}

.canvas-presence {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 8;
  pointer-events: none;
  transition: transform 120ms linear;
}

.canvas-presence.is-instant {
  transition: none;
}

.canvas-presence-cursor {
  position: absolute;
  left: -3px;
  top: -2px;
  filter: drop-shadow(0 1px 1.5px rgba(15, 23, 42, 0.3));
}

.canvas-presence-label {
  position: absolute;
  left: 14px;
  top: 16px;
  border-radius: 4px;
  background: var(--presence-color);
  padding: 3px 6px;
  color: var(--canvas-presence-text);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
</style>
