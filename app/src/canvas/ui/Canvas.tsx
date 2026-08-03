import { createEffect, onCleanup, onMount } from "solid-js";
import type * as Y from "yjs";
import { CanvasProperties } from "#canvas/ui/CanvasProperties.tsx";
import { CanvasToolbar } from "#canvas/ui/CanvasToolbar.tsx";
import { CanvasToolProperties } from "#canvas/ui/CanvasToolProperties.tsx";
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
import "#canvas/ui/CanvasHostElement.ts";
import { type Accessor, createMemo, createSignal } from "solid-js";
import type { CanvasDocumentCollaboration } from "#canvas/document/collaboration.ts";
import type { CanvasView } from "#canvas/runtime/controller.ts";
import type { CanvasHostElement } from "#canvas/ui/CanvasHostElement.ts";

// --- chrome bridge ---------------------------------------------------------
// Between the framework-free element and the Solid chrome beside it. Here
// because this file builds it; the toolbars only consume it.

/**
 * The seam between the immediate-mode canvas and its Solid chrome.
 *
 * The canvas tracks nothing. It cannot say which value changed, only that it
 * painted — so that is all it reports, and this turns "painted" into a signal.
 *
 * Chrome reads the canvas through `frame(...)`, which re-runs the read once per
 * painted frame. That sounds expensive during a drag and is not: the reads are
 * property lookups, and a memo whose result is unchanged stops there, so the
 * DOM is only touched when something the chrome actually shows has moved.
 *
 * The alternative — mirroring each value into its own signal — would put the
 * canvas back in the business of knowing what changed, which is the thing that
 * was deliberately removed from it.
 */
export interface CanvasChrome {
  /** Null until the element has started. */
  view: Accessor<CanvasView | null>;
  /** Re-read the canvas once per painted frame. */
  frame<T>(read: () => T): Accessor<T>;
  /**
   * Run a canvas command from the chrome, then repaint.
   *
   * Chrome lives outside the element, so it misses the host's own input
   * listener; this is the same "input, update, draw" step, said explicitly.
   */
  run(command: (view: CanvasView) => void): void;
  /** Called by the host after each paint. */
  onFrame(): void;
}

/**
 * Chrome sits above the viewport, which starts a drag on pointerdown.
 *
 * Every panel needs this on its outermost element, so it lives with the bridge
 * rather than being redefined in each one.
 */
export const swallowPointer = (event: PointerEvent) => event.stopPropagation();

export function createCanvasChrome(
  host: () => CanvasHostElement | undefined,
): CanvasChrome {
  // Bumped per paint. `equals: false` because the count is not the point —
  // every paint has to invalidate, including one that lands on the same number.
  const [painted, setPainted] = createSignal(0, { equals: false });

  // `equals: false` for the same reason `painted` has it: the view object is the
  // same instance every frame, so a memo with default equality would swallow the
  // change and never notify. Readers that call straight through to `view()` —
  // rather than wrapping in `frame()` — depend on this to see a new frame at all.
  const view = createMemo(
    () => {
      painted();
      return host()?.view ?? null;
    },
    undefined,
    { equals: false },
  );

  return {
    view,
    frame<T>(read: () => T): Accessor<T> {
      return createMemo(() => {
        painted();
        return read();
      });
    },
    run(command) {
      const current = view();
      if (!current) return;
      command(current);
      host()?.requestFrame();
    },
    onFrame() {
      setPainted((count) => count + 1);
    },
  };
}

// Side-effect import: the module registers <vektor-canvas>. Importing only the
// type erases the statement at build time, and then the element never upgrades
// — `host.changed()` throws and the canvas renders nothing.

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
    () => props.documentId,
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
      <CanvasToolProperties chrome={chrome} />
      <CanvasProperties chrome={chrome} />
      <CanvasToolbar chrome={chrome} />
      {/* A static tag, not `<Dynamic>`: the element name is fixed, and Dynamic
          would re-create it on every render of the parent. */}
      <vektor-canvas ref={host as never} />
    </div>
  );
}
