import { createEffect, onCleanup, onMount } from "solid-js";
import type * as Y from "yjs";
import { useCanvasCursorColor } from "#composeables/useCanvasCursorColor.ts";
import {
  type CollaborationPresenceProfile,
  useCollaboration,
} from "#composeables/useCollaboration.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { useDocument } from "#composeables/useDocument.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import type {
  CanvasPresenceState,
  DocumentPresenceState,
} from "#editor/collaboration.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { CanvasToolbar } from "./view/CanvasToolbar.tsx";
import { createCanvasChrome } from "./view/chrome.ts";
// Side-effect import: the module registers <vektor-canvas>. Importing only the
// type erases the statement at build time, and then the element never upgrades
// — `host.changed()` throws and the canvas renders nothing.
import "./CanvasHostElement.ts";
import type { CanvasHostElement } from "./CanvasHostElement.ts";
import type { CanvasDocumentCollaboration } from "./document/collaboration.ts";

/**
 * The Solid adapter for `<vektor-canvas>`.
 *
 * The canvas is framework-free and cannot call a composable, so this resolves
 * the ones it needs and writes them as properties. Nothing else belongs here —
 * no state, no rendering, no event handling.
 */
interface Props {
  spaceId: string;
  documentId?: string;
  ydoc: Y.Doc;
  presenceProfiles?: CollaborationPresenceProfile<CanvasPresenceState>[];
  onPresence?: (states: CanvasPresenceState[]) => void;
}

export function Canvas(props: Props) {
  let host: CanvasHostElement | undefined;

  const toast = useToast();
  const { document: documentData, saveDocument } = useDocument(
    props.documentId,
    "canvas",
  );
  const { currentSpace, spaces } = useSpace();
  const { documents } = useDocuments();
  const currentUser = useUserProfile();
  const { appearance } = useCosmetics();
  const { cursorColorOverride } = useCanvasCursorColor();
  const { uploadFile } = useUploads();

  /**
   * Adapts `useCollaboration` to the plain interface the canvas can read.
   *
   * Called per embedded document when the reader opens one for editing. Solid's
   * owner disposes it; the canvas calls `dispose()` when the edit session ends.
   */
  function createCollaboration(options: {
    spaceId: string;
    documentId: string;
  }): CanvasDocumentCollaboration {
    const session = useCollaboration<DocumentPresenceState>({
      spaceId: options.spaceId,
      documentId: () => options.documentId,
    });

    const listeners = new Set<() => void>();
    const notify = () => {
      for (const listener of [...listeners]) listener();
    };
    createEffect(() => {
      void session.presenceProfiles();
      void appearance();
      notify();
    });

    return {
      ydoc: () => session.ydoc(),
      joinUntilReady: () => session.joinUntilReady(),
      setPresenceState: (state) => session.setPresenceState(state),
      setupPresence: () => session.setupPresence(),
      updatePresence: () => session.updatePresence(),
      presenceProfiles: () => session.presenceProfiles(),
      appearance: () => appearance(),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        listeners.clear();
        session.dispose();
      },
    };
  }

  const chrome = createCanvasChrome(() => host);
  const isDark = chrome.frame(() => chrome.view()?.state.isDarkMode ?? false);

  // One effect for the whole property surface: every value is reactive, and the
  // element coalesces the writes into a single render anyway.
  createEffect(() => {
    if (!host) return;

    host.spaceid = props.spaceId;
    host.documentid = props.documentId;
    host.ydoc = props.ydoc;
    host.presence = props.presenceProfiles ?? [];
    host.currentuserid = currentUser()?.id;
    // An explicit preference overrides the automatic avatar colour; `null`
    // means automatic, so presence matches the user's avatar.
    host.cursorcolor = cursorColorOverride() ?? getAvatarColor(currentUser()?.id);
    host.cursorcompanion = appearance().cursorCompanion ?? null;
    host.canedit = canEdit(currentSpace()?.userRole);
    host.gridtype = documentData()?.properties?.gridtype as string | undefined;
    host.documents = () => documents();
    host.spaces = () => spaces();
    host.uploadfile = (file, target) => uploadFile(file, target);
    host.createcollaboration = createCollaboration;
    host.save = (snapshot) => saveDocument(snapshot as string);
    host.error = (message) => toast.error(message);
    host.onpresence = (states) => props.onPresence?.(states);
    host.onframe = chrome.onFrame;
    host.changed();
  });

  onMount(() => host?.changed());
  onCleanup(() => host?.destroy());

  // `.canvas-root` is Solid's, not the element's: it is the positioning context
  // and the CSS-variable scope for both the chrome beside the element and the
  // viewport inside it.
  return (
    <div classList={{ "canvas-root": true, "is-dark": isDark() }}>
      <CanvasToolbar chrome={chrome} />
      {/* A static tag, not `<Dynamic>`: the element name is fixed, and Dynamic
          would re-create it on every render of the parent. */}
      <vektor-canvas ref={host as never} />
    </div>
  );
}
