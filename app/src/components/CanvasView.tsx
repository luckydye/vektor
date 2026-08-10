import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Canvas } from "#canvas/index.ts";
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

export function CanvasView(props: Props) {
  const documentId = createMemo(() => props.documentId);
  const [hasMounted, setHasMounted] = createSignal(false);

  const collaboration = useCollaboration<CanvasPresenceState>({
    spaceId: props.spaceId,
    documentId,
  });
  provideCollaboration(collaboration);

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

    void collaboration.joinUntilReady();
    collaboration.setPresenceState(state);
    void collaboration.setupPresence();
    collaboration.updatePresence(state);
  }

  onMount(() => {
    setHasMounted(true);
    extensions.setActiveCollaboration(collaboration.ydoc());
    extensions.setActiveDocumentId(documentId() ?? null);

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
          ydoc={collaboration.ydoc()}
          presenceProfiles={presenceProfiles()}
          onPresence={handlePresence}
        />
      </div>
    </Show>
  );
}
