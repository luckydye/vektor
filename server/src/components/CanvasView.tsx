import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { api } from "#api/client.ts";
import type { CanvasTransport } from "#canvas/document/canvasSync.ts";
import { Canvas } from "#canvas/index.ts";
import { localCanvasTransport } from "#canvas/runtime/canvasDocument.ts";
import {
  provideCollaboration,
  useCollaboration,
} from "#composeables/useCollaboration.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import { extensions } from "#extensions/manager.ts";

interface Props {
  spaceId: string;
  documentId?: string;
}

/** The canvas room and load endpoint of one document, over the app's realtime client. */
function documentCanvasTransport(spaceId: string, documentId: string): CanvasTransport {
  return {
    join: (handlers) => api.joinCanvasRoom(spaceId, documentId, handlers),
    load: (query) => api.loadCanvas(spaceId, documentId, query),
  };
}

export function CanvasView(props: Props) {
  const documentId = createMemo(() => props.documentId);
  const [hasMounted, setHasMounted] = createSignal(false);

  const collaboration = useCollaboration<CanvasPresenceState>({
    spaceId: props.spaceId,
    documentId,
  });
  provideCollaboration(collaboration);

  // A new transport is a new canvas: the host restarts its controller on it.
  const transport = createMemo(() => {
    const id = documentId();
    return id ? documentCanvasTransport(props.spaceId, id) : localCanvasTransport();
  });

  const presenceProfiles = createMemo(() =>
    collaboration
      .presenceProfiles()
      .filter((profile) => profile.state?.kind === "canvas"),
  );

  function handlePresence(states: CanvasPresenceState[]) {
    const [state] = states;
    if (!state) {
      collaboration.clearPresence();
      return;
    }

    // Presence only: the canvas syncs through its own room, not a Yjs one.
    collaboration.setPresenceState(state);
    void collaboration.setupPresence();
    collaboration.updatePresence(state);
  }

  // An effect, not `onMount`: a canvas → canvas navigation swaps the props
  // without remounting, and extensions would keep acting on the old document.
  createEffect(() => {
    // A canvas has no Y.Doc to hand extensions.
    extensions.setActiveCollaboration(null);
    extensions.setActiveDocumentId(documentId() ?? null);
  });

  onMount(() => {
    setHasMounted(true);

    onCleanup(() => {
      extensions.setActiveCollaboration(null);
      extensions.setActiveDocumentId(null);
      collaboration.clearPresence();
    });
  });

  return (
    <Show when={hasMounted()}>
      <div class="h-screen">
        <Canvas
          documentId={documentId()}
          spaceId={props.spaceId}
          transport={transport()}
          plugins={extensions.canvasPlugins}
          presenceProfiles={presenceProfiles()}
          onPresence={handlePresence}
        />
      </div>
    </Show>
  );
}
