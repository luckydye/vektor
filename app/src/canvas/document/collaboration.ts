import type * as Y from "yjs";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import type {
  DocumentPresenceProfile,
  DocumentPresenceState,
} from "#editor/collaboration.ts";

/**
 * A collaboration session, as the canvas sees it.
 *
 * The app's session is `useCollaboration`, which exposes reactive accessors.
 * The canvas cannot read those, so this is the same session behind a plain
 * interface: getters for the current values and one subscription for
 * "something changed". The component shell adapts one to the other, the same
 * way it already resolves the user, the space role and the uploader into
 * properties.
 *
 * Only the inline document editor needs this — the canvas embeds a document,
 * and that document has its own Yjs room and its own presence.
 */
export interface CanvasDocumentCollaboration {
  ydoc(): Y.Doc;
  joinUntilReady(): Promise<void>;
  setPresenceState(state: DocumentPresenceState): void;
  setupPresence(): Promise<void> | void;
  updatePresence(): void;
  presenceProfiles(): DocumentPresenceProfile[];
  /** The local user's cosmetic appearance, for their own cursor. */
  appearance(): PublicUserAppearance | undefined;
  /** Fires when `presenceProfiles()` or `appearance()` would return something new. */
  subscribe(listener: () => void): () => void;
  /**
   * Leaves the room and releases every listener.
   *
   * Explicit because the owner is a custom element, not a component: there is
   * no unmount hook to hang it on.
   */
  dispose(): void;
}

/** Creates a session for one embedded document. Supplied by the app shell. */
export type CanvasCollaborationFactory = (options: {
  spaceId: string;
  documentId: string;
}) => CanvasDocumentCollaboration;
