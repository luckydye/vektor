/**
 * The document layer's public surface — the canvas library's server-safe entry.
 *
 * Separate from `#canvas/index.ts` because that barrel re-exports `ui/`, and
 * `ui/` reaches the app's composables and `@solidjs/router`, which ships only a
 * client build. Importing the full barrel from anything that runs under plain
 * Bun (`src/server.ts` and everything it pulls in) therefore throws
 * "Client-only API called on the server side" at import time.
 *
 * Nothing reachable from here may import from `render/`, `runtime/`, `extensions/`
 * or `ui/`. `yjs` is the only runtime dependency; keep it that way.
 */

export type {
  CanvasCollaborationFactory,
  CanvasDocumentCollaboration,
} from "#canvas/document/collaboration.ts";
export {
  CANVAS_SHAPES_KEY,
  CANVAS_STROKES_KEY,
  parseCanvasContent,
  seedCanvasDoc,
} from "#canvas/document/yjs.ts";
