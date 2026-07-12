# Canvas.vue → Extension System Refactor

## Goal
Turn `app/src/components/Canvas.vue` (5,828 lines) from a monolith with `shape.type === "..."`
branches into a thin **host/engine** that delegates all per-type behavior to self-contained
**element extensions**, mirroring the rich-text-editor's extension registry + `addNodeView`
custom-element pattern.

## Design decisions (confirmed)
- **Rendering:** custom elements per type (like the editor's `addNodeView`). The host places one
  element per shape; canvas-2d-painted types (static image pixels, sections) provide a `paint()`
  hook instead of DOM.
- **Rollout:** full extraction in one pass, staged as build-green commits.

## Current state
`app/src/canvas/elements/*.ts` already exist but only hold thin metadata (`defaultSize`,
`minSize`, `isValid`) + factory functions. Every piece of real behavior — DOM rendering, canvas
painting, hit-testing, transforms, auto-sizing, inline editing, serialization, paste/drop routing
— is still hardcoded in Canvas.vue as `shape.type === "..."` branches.

---

## 1. The extension contract

Extend the current thin `CanvasElementDefinition` into a full `CanvasElementExtension`
(`canvas/elements/types.ts`). One object per type; each element module exports it.

```ts
interface CanvasElementExtension {
  // metadata (already exists)
  type: CanvasElementType;                 // + "section" becomes first-class
  defaultText: string; defaultColor: string;
  defaultSize: CanvasSize; minSize: CanvasSize;
  isValid?(shape): boolean;

  // creation
  create(at, ctx): CanvasShape;            // factory (createNoteShape etc.)
  tool?: { id: CanvasTool; label; shortcut; icon }; // optional toolbar entry

  // rendering
  surface: "dom" | "canvas" | "dom+canvas";
  tag?: string;                            // custom-element tag, e.g. "canvas-note"
  paint?(ctx2d, shape, h: PaintHelpers): void;   // for canvas/dom+canvas
  hitTest?(shape, worldPt, h): boolean;    // canvas-drawn types only (DOM uses native events)

  // geometry / transforms (replaces selectedTransformShape/Resizable* branches)
  transform: { move: boolean; resize: "box"|"font"|"none"; rotate: boolean; aspectLocked?: boolean };
  autosize?: "observe-dom" | "none";       // text + link cards use observe-dom

  // serialization quirks (replaces text width/height special-casing)
  writeYMap?(map: Y.Map, shape): void;     // createShapeMap hook
  readYMap?(read, base): Partial<CanvasShape>; // toShape hook
  serialize?(shape): CanvasSerializedShape;

  // paste/drop recognizers (replaces the numbered branches in handlePaste/handleDrop)
  matchPaste?(data: DataTransfer, ctx): PasteCandidate | null;
  matchDrop?(data: DataTransfer, ctx): DropCandidate | null;
}
```

## 2. The host context (`CanvasHostContext`)

Because custom elements can't use Vue reactivity directly, the host passes a context object +
the shape as element **properties** (exactly like `rich-text-editor.value`):

```ts
el.shape = shape;            // re-renders on set
el.context = hostContext;    // shared controllers, set once
```

`hostContext` exposes what elements need from the host:
- `documentLinks`, `linkPreviews` controllers
- editing state (`editingDocumentShape`, section title, text toolbar retarget)
- `worldToScreen` / `transform` (for cards that need scale)
- permissions (`canEdit`), `toast`, `t()` i18n
- callbacks: `updateShapeText`, `selectOnlyShape`, `requestEdit`, `openDocument`, …

Elements communicate **up** via bubbling `CustomEvent`s (`content-change`, `request-edit`,
`open-document`, `resize`) — the same convention the editor already uses (`editor-blur`, etc.).
The host listens once via event delegation on the viewport.

## 3. New file layout (`app/src/canvas/elements/`)

Each existing metadata module gains its custom element + hooks (co-located):

| type      | module              | custom element      | surface     | notes |
|-----------|---------------------|---------------------|-------------|-------|
| note      | note.ts             | `canvas-note`       | dom         | wraps rich-text-editor |
| text      | text.ts             | `canvas-text`       | dom         | rich-text-editor, fontScale resize, observe-dom autosize, blur-removes-empty |
| image     | media.ts            | `canvas-image`      | dom+canvas  | gif→DOM `<img>`, else canvas paint + hit-test; aspect-locked |
| video     | media.ts            | `canvas-video`      | dom         | `<video>` autoplay; aspect-locked |
| audio     | media.ts            | `canvas-audio`      | dom         | native player bar; fixed box |
| file      | files.ts            | `canvas-file`       | dom         | pdf→iframe, else `<file-attachment>`; click-vs-drag guard |
| document  | documentLink.ts     | `canvas-document`   | dom         | preview `<document-attachment>` / inline `CanvasDocumentEditor`; open-on-click |
| link      | link.ts             | `canvas-link`       | dom         | twitter embed / card; observe-dom autosize |
| section   | **new** section.ts  | (none)              | canvas      | paint chrome + title; border/title hit-test; resize-only; title-edit overlay |

`registry.ts` aggregates all extensions (add `section`), and its helper functions
(`defaultSizeForShape`, etc.) read from the registry with no hardcoded section fallbacks.

## 4. What STAYS in Canvas.vue (the engine — not type-specific)

- Viewport/camera/transform, grid render, pan/zoom (`#viewport`)
- Drag/resize/rotate state machine (`DragState`), marquee, snap guides
- Selection state + transform-control **chrome** (rotate/resize handles) — reads
  `ext.transform` flags to decide which handles to show
- Undo/redo (`Y.UndoManager`), save pipeline, Yjs sync loop (`syncShapesFromY`)
- Collaboration presence (cursors, remote selections)
- Tool state + keyboard shortcuts; `CANVAS_TOOLS` built by collecting `ext.tool`
- Clipboard **orchestration** (copy/cut) — paste/drop **routing** delegates to
  `ext.matchPaste`/`matchDrop`
- Freehand drawing + shape-library strokes (a parallel stroke system — out of scope, unchanged)

## 5. Migration mapping (host branch → extension hook)

- `domShapes` / `visibleImageShapes` / `sectionShapes` computeds → host asks registry per shape
  for `surface`; one DOM loop renders `<component-tag :shape>`, canvas loop calls `ext.paint`.
- `selectedTransformShape` / `selectedResizableSection` / `selectedResizableDocument` →
  single `selectedTransform = ext.transform` lookup.
- `startShapeResize` / resize-apply `isText`/`isMedia` branches → `ext.transform.resize` +
  `aspectLocked`.
- `startShapeRotation` section block → `ext.transform.rotate`.
- `createShapeMap` / `serializeShape` / `toShape` / `updateShape` text branches →
  `ext.writeYMap` / `ext.serialize` / `ext.readYMap`.
- text ResizeObserver + link card fit machinery → generic `autosize:"observe-dom"` driver in host
  keyed by `[data-shape-id]`, element reports intrinsic size via a `resize`/measure event.
- hit-test ordering (image → stroke → section title → section border) → host iterates registry
  `hitTest` hooks in z-order; strokes stay host-owned.
- `handlePaste` / `handleDrop` numbered branches → loop over `ext.matchPaste`/`matchDrop`.
- inline editing: text toolbar retarget, section title overlay, document embed edit — element
  fires `request-edit`; host owns the shared toolbar + `CanvasDocumentEditor` mount + section
  title input (these are host-level singletons).

## 6. Risks / verification
- **Reactivity boundary:** shapes flow Vue→element via property set; must re-set `.shape` when the
  host's shape object changes (watch `shapes`). Preview/editing updates pushed through context.
- **Collab/undo byte-compatibility:** serialization hooks must reproduce current `createShapeMap`
  output exactly (incl. text width/height omission and conditional fields) or Yjs docs diverge.
- **Inline-editing singletons:** shared formatting toolbar, `CanvasDocumentEditor` mount, and
  section-title input stay host-owned; elements only fire `request-edit`.
- Verify end-to-end per type: create, drag, resize, rotate, edit text, paste image/url/doc,
  drop file, section title edit, document inline edit, lock/unlock, GIF vs static image,
  multi-select marquee, remote presence — via the `/verify` skill + real app run.
- No agent/model-driven tests (hits local Ollama). Use Bun, not npm.

## Status — complete (pending runtime verification)

Branch `refactor/canvas-extensions`. Build green (`tsgo` at the pre-existing baseline)
after every commit. `.vue` templates are not type-checked by tsgo, so the host template
wiring still needs one runtime pass in the app.

**Done:**
- Extension contract + registry (+ `section` first-class). [`types.ts`, `registry.ts`, `section.ts`]
- Serialization routed through the registry (`serializeCanvasShape` / `shapePersistsSize`,
  text `serialize` hook); Yjs output byte-identical.
- All DOM element types render via custom elements: `<canvas-note>`, `<canvas-text>`
  (`CanvasRichTextElement`), `<canvas-image>` (GIF), `<canvas-video>`, `<canvas-audio>`,
  `<canvas-file>`, `<canvas-link>` (card), `<canvas-document>` (preview). Host dispatches via
  `<component :is="elementTagForShape(shape)">`; the fallback is reduced to the two host-owned
  Vue renderings (`<CanvasDocumentEditor>` while editing, `<CanvasTwitterEmbed>`), selected by
  `elementTagForShape` returning null.
- Section painting (frame + title) moved into `sectionElement.paint`; host `renderSections`
  just drives the layer + hook.
- Tools (`CANVAS_TOOLS`), creation (`addShape` → `ext.create`), and transform capability
  (`selectedTransformShape`, `startShapeResize` aspect/font, `startShapeRotation`) are
  registry-driven. Dead per-type template branches + helpers removed.

**Deliberately host-owned (engine, not per-type — documented, not TODO):**
- **Static-image pixel painting** (`renderImages`): image cache, resolution-tier selection,
  and selection overlays are shared engine concerns; the per-type knowledge (aspect lock, GIF
  routing) already lives in metadata. GIF images render via `<canvas-image>`.
- **Hit-testing** (`hitTestImageShape` / `hitTestSectionBorder` / `hitTestSectionTitle`):
  tightly ordered cross-type z-order logic (image → stroke → section title → section border)
  that also feeds selection and the title-edit overlay; sections need a dual border/title
  region a single `hitTest` boolean can't express.
- **Paste/drop routing** (`handlePaste` / `handleDrop`): orchestration that consumes
  recognizers already owned by the element modules (`dragHasCanvasFiles`,
  `mediaFilesFromDataTransfer`, `parseCanvasClipboard*`, `getDroppedDocumentReference`); the
  recognizers are the extension's concern, the ordering/async flow is the host's.
- **Article wrapper** (position/rotation/selection class, text font-size var, image
  no-background): host-owned layout for the positioned card; element bodies fill it.

**Before merge:** verify per type via `/verify` + a real app run (no model-driven tests —
Ollama): create/drag/resize/rotate a note & text; formatting toolbar on focus; empty text
deletes on blur; paste image/URL/doc; drop a file; open a PDF; document card inline-edit +
external open; GIF vs static image; section create + title edit + resize; multi-select
marquee; remote presence.

## 7. Commit sequence (single-pass, staged for reviewability)
1. Extend contract in `types.ts` + registry aggregation (+ section extension), no host changes.
2. Add serialization hooks; route `toShape`/`createShapeMap`/`serialize` through registry.
3. Build custom elements for each DOM type; host renders via tags (one type at a time within
   the pass, keeping build green after each).
4. Move image/section paint + hit-test into `paint`/`hitTest`.
5. Collapse transform/autosize/paste-drop branches to registry lookups.
6. Delete dead per-type code from Canvas.vue; final host is the engine only.
