import { createEffect, createSignal, on } from "solid-js";
import "#editor/elements/code-editor.ts";
import { reportJoinFailure, useCollaboration } from "#composeables/useCollaboration.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import {
  currentEditorPresenceState,
  type DocumentPresenceProfile,
  type DocumentPresenceState,
} from "#editor/collaboration.ts";
import type { CodeEditorElementApi } from "#editor/elements/code-editor.ts";
import { DockedPanel } from "./DockedPanel.tsx";

interface Props {
  documentId: string;
  spaceId: string;
}

export function WorkflowEditorOverlay(props: Props) {
  const [codeEditor, setCodeEditor] = createSignal<CodeEditorElementApi | null>(null);
  const collaboration = useCollaboration<DocumentPresenceState>({
    spaceId: props.spaceId,
    documentId: () => props.documentId,
  });
  const { appearance } = useCosmetics();

  function updatePresence() {
    collaboration.updatePresence(
      currentEditorPresenceState(codeEditor()?.editorInstance),
    );
  }

  function updatePresenceSoon() {
    queueMicrotask(updatePresence);
  }

  createEffect(() => {
    const ydoc = collaboration.ydoc();
    const editor = codeEditor();
    if (editor) editor.collaborationDocument = ydoc;
  });

  createEffect(() => {
    const editor = codeEditor();
    if (editor) editor.appearance = appearance();
  });

  createEffect(() => {
    const editor = codeEditor();
    const editorProfiles = collaboration
      .presenceProfiles()
      .filter(
        (profile): profile is DocumentPresenceProfile => profile.state?.kind === "editor",
      );
    editor?.setPresenceProfiles(editorProfiles);
  });

  createEffect(
    on(
      () => props.documentId,
      async () => {
        try {
          await collaboration.joinUntilReady();
        } catch (error) {
          // Presence in a room that never synced would announce an editor
          // showing nothing, so it stays behind the join.
          reportJoinFailure(error);
          return;
        }
        collaboration.setPresenceState(
          currentEditorPresenceState(codeEditor()?.editorInstance),
        );
        void collaboration.setupPresence();
      },
    ),
  );

  return (
    <DockedPanel
      id="workflow-editor"
      title="Workflow Editor"
      defaultSide="right"
      defaultWidth={720}
      defaultMode="floating"
    >
      <div class="flex h-full flex-col bg-background">
        <code-editor
          ref={setCodeEditor as never}
          class="min-h-0 flex-1"
          language="javascript"
          on:presence-change={updatePresence}
          on:selection-change={updatePresence}
          on:editor-focus={updatePresenceSoon}
          on:editor-blur={updatePresenceSoon}
        />
      </div>
    </DockedPanel>
  );
}
