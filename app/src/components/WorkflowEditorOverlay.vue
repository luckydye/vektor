<script setup lang="ts">
import { onMounted, ref, toRef, watch } from "vue";
import "#editor/elements/code-editor.ts";
import type { CodeEditorElementApi } from "#editor/elements/code-editor.ts";
import { useCollaboration } from "#composeables/useCollaboration.ts";
import {
  currentEditorPresenceState,
  type DocumentPresenceProfile,
  type DocumentPresenceState,
} from "#editor/collaboration.ts";
import DockedPanel from "./DockedPanel.vue";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

const codeEditor = ref<CodeEditorElementApi | null>(null);
const collaboration = useCollaboration<DocumentPresenceState>({
  spaceId: props.spaceId,
  documentId: toRef(props, "documentId"),
});

function updatePresence() {
  collaboration.updatePresence(
    currentEditorPresenceState(codeEditor.value?.editorInstance),
  );
}

function updatePresenceSoon() {
  queueMicrotask(updatePresence);
}

function setupPresence() {
  collaboration.setPresenceState(
    currentEditorPresenceState(codeEditor.value?.editorInstance),
  );
  void collaboration.setupPresence();
}

watch(
  [codeEditor, collaboration.ydoc],
  ([editor, ydoc]) => {
    if (editor) editor.collaborationDocument = ydoc;
  },
  { immediate: true },
);

watch(
  [codeEditor, collaboration.presenceProfiles],
  ([editor, profiles]) => {
    const editorProfiles = profiles.filter(
      (profile): profile is DocumentPresenceProfile => profile.state?.kind === "editor",
    );
    editor?.setPresenceProfiles(editorProfiles);
  },
  { immediate: true },
);

onMounted(async () => {
  await collaboration.joinUntilReady();
  setupPresence();
});
</script>

<template>
  <DockedPanel
    id="workflow-editor"
    title="Workflow Editor"
    default-side="right"
    :default-width="720"
    default-mode="floating"
  >
    <div class="flex flex-col h-full bg-background">
      <code-editor
        ref="codeEditor"
        class="flex-1 min-h-0"
        language="javascript"
        @presence-change="updatePresence"
        @selection-change="updatePresence"
        @editor-focus="updatePresenceSoon"
        @editor-blur="updatePresenceSoon"
      />
    </div>
  </DockedPanel>
</template>
