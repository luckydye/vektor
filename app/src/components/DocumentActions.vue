<script setup lang="ts">
import { Icon, ContextMenu, ContextMenuItem, ButtonPrimary, ButtonSecondary } from "~/src/components";
import Contributors from "./Contributors.vue";
import { onMounted, onUnmounted, ref, computed, watchEffect } from "vue";
import { useSpace } from "../composeables/useSpace.ts";
import { Actions, type ActionOptions } from "../utils/actions.js";
import { api } from "../api/client.ts";
import { canEdit } from "../composeables/usePermissions.ts";

const props = defineProps<{
  documentId?: string,
  title?: string,
  readonly: boolean
}>();

const { currentSpaceId, currentSpace } = useSpace();

const userCanEdit = computed(() => {
  return canEdit(currentSpace.value?.userRole);
});

const isEditing = ref(!props.documentId);
const isSaving = ref(false);
const isCreatingToken = ref(false);
const editorSaveFunction = ref<(() => Promise<void>) | null>(null);

function startEditing() {
  isEditing.value = true;
  window.dispatchEvent(new CustomEvent("edit-mode-start"));
  
  Actions.register("document:save", {
    title: "Save Document",
    description: "Save current document and exit edit mode",
    group: "edit",
    run: async () => stopEditing(),
  });
  
  Actions.unregister("document:edit");
}

Actions.register("document:edit", {
  title: "Edit Document",
  description: "Start editing mode for current document",
  group: "edit",
  run: async () => startEditing(),
});

Actions.register("document:print", {
  title: "Print",
  icon: () => "print",
  description: "Print current document",
  group: "document",
  run: async () => {
    window.print();
  },
});

Actions.register("document:export", {
  title: "Export",
  icon: () => "download",
  description: "Export current document to markdown",
  group: "document",
  run: async () => {
    window.open(`${location.href}.md`, "_blank");
  },
});

Actions.register("document:accesstoken", {
  title: "Copy API Command",
  icon: () => "webhook",
  description: "Creates API token to access this document",
  group: "document",
  run: async () => {
    if (isCreatingToken.value) return;

    try {
      isCreatingToken.value = true;

      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }

      if (!props.documentId) {
        return;
      }

      // Create a 30-day access token for this document
      const documentName = props.title || props.documentId;
      const tokenResult = await api.accessTokens.create(currentSpaceId.value, {
        name: `API Access: ${documentName} (${new Date().toISOString().split('T')[0]})`,
        resourceType: "document",
        resourceId: props.documentId,
        permission: "editor",
        expiresInDays: 30,
      });

      const command = `curl -X PUT ${location.origin}/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId} \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer ${tokenResult.token}" \\
    -d '{"content": "<html>Your content here</html>"}'`;

      await navigator.clipboard.writeText(command);

      // Show success message
      alert(`✓ API command copied to clipboard!\n\nA 30-day access token has been created and included.\nToken ID: ${tokenResult.id}`);
    } catch (error) {
      console.error("Failed to create token:", error);
      alert("❌ Failed to create access token. Please check your permissions and try again.");
    } finally {
      isCreatingToken.value = false;
    }
  },
});

const actions = ref<[string, ActionOptions][]>([]);
const actionsDanger = ref<[string, ActionOptions][]>([]);

async function stopEditing() {
  if(!isEditing.value) return;

  if (editorSaveFunction.value) {
    isSaving.value = true;
    try {
      await editorSaveFunction.value();
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("Failed to save:", error);
    }
  }
  isEditing.value = false;
  if (props.documentId) {
    window.location.reload();
  }
  
  Actions.unregister("document:save");
}

function cancelEditing() {
  isEditing.value = false;
  if (props.documentId) {
    window.location.reload();
  } else {
    window.history.back();
  }
}

function handleEditorReady(event: CustomEvent<{ saveFunction: () => Promise<void> }>) {
  editorSaveFunction.value = event.detail.saveFunction;
  isEditing.value = true;
}

onMounted(async () => {
  window.addEventListener("editor-ready", handleEditorReady as EventListener);

  Actions.subscribe("actions:register", () => {
    actions.value = Actions.group("document");
    actionsDanger.value = Actions.group("document:danger");
  })
  Actions.subscribe("actions:unregister", () => {
    actions.value = Actions.group("document");
    actionsDanger.value = Actions.group("document:danger");
  })

  actions.value = Actions.group("document");
  actionsDanger.value = Actions.group("document:danger");
});

onUnmounted(() => {
  window.removeEventListener("editor-ready", handleEditorReady as EventListener);
});

function runContextMenuAction(e: Event, name: string) {
  Actions.run(name);
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

watchEffect(() => {
  Actions.unregister("document:archive");

  if (userCanEdit.value === true) {
    Actions.register("document:archive", {
      title: "Archive Document",
      icon: () => "archive",
      description: "Archive current document",
      group: "document:danger",
      run: async () => {
        if (!confirm("Are you sure you want to archive this document?")) {
          return;
        }

        if (!currentSpaceId.value) {
          throw new Error("No space selected");
        }

        if (!props.documentId) {
          return;
        }

        const response = await fetch(
          `/api/v1/spaces/${currentSpaceId.value}/documents/${props.documentId}`,
          {
            method: "DELETE",
          },
        );

        if (!response.ok) {
          throw new Error(`Archive failed: ${response.statusText}`);
        }

        window.location.href = `/`;
      },
    });
  }
})
</script>

<template>
  <div id="document-actions" class="flex gap-4 items-start">
    <div class="flex-1">
      <Contributors v-if="documentId" :documentId="documentId" />
    </div>

    <ButtonPrimary
      v-if="!isEditing && !readonly && userCanEdit"
      @click="startEditing"
    >
      <Icon name="edit" />
      <span>Edit</span>
    </ButtonPrimary>

    <div v-if="isEditing" class="flex items-center gap-2">
      <ButtonPrimary @click="stopEditing">
        <Icon name="check" />
        <span>{{isSaving ? 'Saving...' : 'Done'}}</span>
      </ButtonPrimary>

      <ButtonSecondary @click="cancelEditing">
        <Icon name="close" />
        <span>Cancel</span>
      </ButtonSecondary>
    </div>

    <ContextMenu>
      <ContextMenuItem v-for="[name, options] of actions" :onClick="(event) => runContextMenuAction(event, name)">
        <Icon :name="options.icon?.() || 'placeholder'" />
        <span :data-action="name">{{options.title}}</span>
      </ContextMenuItem>

      <hr v-if="actionsDanger.length > 0" />

      <ContextMenuItem v-for="[name, options] of actionsDanger" :onClick="(event) => runContextMenuAction(event, name)" class="text-orange-600 hover:text-orange-700">
        <Icon :name="options.icon?.() || 'placeholder'" />
        <span>{{options.title}}</span>
      </ContextMenuItem>
    </ContextMenu>
  </div>
</template>
