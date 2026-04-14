<script setup lang="ts">
import {
  Icon,
  ContextMenu,
  ContextMenuItem,
  ButtonSecondary,
} from "~/src/components/index.ts";
import Contributors from "./Contributors.vue";
import WorkflowEditorOverlay from "./WorkflowEditorOverlay.vue";
import { onMounted, onUnmounted, ref, computed, watchEffect } from "vue";
import { useSpace } from "../composeables/useSpace.ts";
import { Actions, type ActionOptions } from "../utils/actions.ts";
import { api } from "../api/client.ts";
import { canEdit } from "../composeables/usePermissions.ts";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";

const props = defineProps<{
  documentId?: string;
  title?: string;
  readonly: boolean;
  documentType?: string;
}>();

const { currentSpaceId, currentSpace } = useSpace();
const { toggle: toggleDockedWindow } = useDockedWindows();

const userCanEdit = computed(() => {
  return canEdit(currentSpace.value?.userRole);
});

const isEditing = ref(!props.documentId);
const isSaving = ref(false);
const isCreatingToken = ref(false);
const saveMode = ref<"revision" | "suggestion">("revision");
const showSaveMenu = ref(false);
const actionMenuRef = ref<HTMLElement | null>(null);
const editorSaveFunction = ref<
  ((mode: "revision" | "suggestion") => Promise<void>) | null
>(null);

function registerEditAction() {
  Actions.register("document:edit", {
    title: "Edit Document",
    description: "Start editing mode for current document",
    group: "edit",
    run: async () => startEditing(),
  });
}

function startEditing() {
  if (props.readonly || !userCanEdit.value) {
    return;
  }

  isEditing.value = true;
  window.dispatchEvent(new CustomEvent("edit-mode-start"));

  Actions.register("document:save", {
    title: "Publish Document",
    description: "Publish current document and exit edit mode",
    group: "edit",
    run: async () => stopEditing("revision"),
  });

  Actions.unregister("document:edit");
}

registerEditAction();

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
        name: `API Access: ${documentName} (${new Date().toISOString().split("T")[0]})`,
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
      alert(
        `✓ API command copied to clipboard!\n\nA 30-day access token has been created and included.\nToken ID: ${tokenResult.id}`,
      );
    } catch (error) {
      console.error("Failed to create token:", error);
      alert(
        "❌ Failed to create access token. Please check your permissions and try again.",
      );
    } finally {
      isCreatingToken.value = false;
    }
  },
});

const actions = ref<[string, ActionOptions][]>([]);
const actionsDanger = ref<[string, ActionOptions][]>([]);

async function stopEditing(mode: "revision" | "suggestion" = "revision") {
  if (!isEditing.value) return;

  saveMode.value = mode;
  showSaveMenu.value = false;

  if (editorSaveFunction.value) {
    isSaving.value = true;
    try {
      await editorSaveFunction.value(mode);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("Failed to save:", error);
    } finally {
      isSaving.value = false;
      saveMode.value = "revision";
    }
  }

  isEditing.value = false;

  Actions.unregister("document:save");
  registerEditAction();

  if (props.documentId && mode === "revision") {
    window.location.reload();
  }
}

function cancelEditing() {
  isEditing.value = false;
  showSaveMenu.value = false;
  if (props.documentId) {
    window.dispatchEvent(new CustomEvent("edit-mode-cancel"));
    Actions.unregister("document:save");
    registerEditAction();
  } else {
    window.history.back();
  }
}

function handleEditorReady(
  event: CustomEvent<{
    saveFunction: (mode: "revision" | "suggestion") => Promise<void>;
  }>,
) {
  editorSaveFunction.value = event.detail.saveFunction;
  isEditing.value = true;
}

function toggleSaveMenu(event: MouseEvent) {
  event.stopPropagation();
  showSaveMenu.value = !showSaveMenu.value;
}

function saveAsSuggestion() {
  void stopEditing("suggestion");
}

function handleClickOutside(event: MouseEvent) {
  if (actionMenuRef.value && !actionMenuRef.value.contains(event.target as Node)) {
    showSaveMenu.value = false;
  }
}

onMounted(async () => {
  window.addEventListener("editor-ready", handleEditorReady as EventListener);
  document.addEventListener("click", handleClickOutside);

  Actions.subscribe("actions:register", () => {
    actions.value = Actions.group("document");
    actionsDanger.value = Actions.group("document:danger");
  });
  Actions.subscribe("actions:unregister", () => {
    actions.value = Actions.group("document");
    actionsDanger.value = Actions.group("document:danger");
  });

  actions.value = Actions.group("document");
  actionsDanger.value = Actions.group("document:danger");
});

onUnmounted(() => {
  window.removeEventListener("editor-ready", handleEditorReady as EventListener);
  document.removeEventListener("click", handleClickOutside);
});

function runContextMenuAction(e: Event, name: string) {
  Actions.run(name);
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

watchEffect(() => {
  Actions.unregister("document:pin");
  Actions.unregister("document:unpin");

  if (userCanEdit.value && currentSpace.value && props.documentId) {
    const isPinned =
      currentSpace.value.preferences?.pinnedDocumentId === props.documentId;

    if (isPinned) {
      Actions.register("document:unpin", {
        title: "Unpin from Home",
        icon: () => "pin-filled",
        description: "Remove this document from the space home page",
        group: "document",
        run: async () => {
          await api.space.patch(currentSpace.value!.id, {
            preferences: { pinnedDocumentId: "" },
          });
          window.location.reload();
        },
      });
    } else {
      Actions.register("document:pin", {
        title: "Pin to Home",
        icon: () => "pin",
        description: "Showcase this document on the space home page",
        group: "document",
        run: async () => {
          await api.space.patch(currentSpace.value!.id, {
            preferences: { pinnedDocumentId: props.documentId! },
          });
          window.location.reload();
        },
      });
    }
  }
});

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
        if (!currentSpace.value) {
          throw new Error("No space loaded");
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

        window.location.href = `/${currentSpace.value.slug}`;
      },
    });
  }
});
</script>

<template>
  <div id="document-actions" class="flex gap-4 items-start">
    <div class="flex-1">
      <Contributors v-if="documentId" :documentId="documentId" />
    </div>

    <button
      v-if="documentType === 'workflow' && documentId && userCanEdit"
      type="button"
      class="button-primary px-3"
      @click="toggleDockedWindow('workflow-editor', { side: 'right', width: 720, mode: 'floating' })"
    >
      <Icon name="edit" />
      <span>Edit</span>
    </button>

    <button
      v-if="!isEditing && !readonly && userCanEdit"
      type="button"
      class="button-primary px-3"
      @click="startEditing"
    >
      <Icon name="edit" />
      <span>Edit</span>
    </button>

    <WorkflowEditorOverlay
      v-if="documentType === 'workflow' && documentId && currentSpaceId"
      :documentId="documentId"
      :spaceId="currentSpaceId"
    />

    <div v-if="isEditing" class="flex items-center gap-2">
      <div ref="actionMenuRef" class="relative">
        <div class="button-primary-base button-with-icon overflow-hidden">
          <button
            type="button"
            class="inline-flex justify-center items-center px-3xs button-primary-pointer"
            :disabled="isSaving"
            @click="stopEditing('revision')"
          >
            <Icon name="check" />
            <span>{{
              isSaving
                ? saveMode === "suggestion"
                  ? "Saving suggestion..."
                  : "Publishing..."
                : "Publish"
            }}</span>
          </button>
          <button
            v-if="documentId"
            type="button"
            class="flex items-center justify-center border-l border-primary-700 px-4xs button-primary-pointer"
            :disabled="isSaving"
            aria-label="Publish options"
            @click="toggleSaveMenu"
          >
            <Icon name="chevron-down" />
          </button>
        </div>

        <div
          v-if="showSaveMenu && documentId"
          class="absolute top-[calc(100%+4px)] right-0 bg-background border border-neutral-100 rounded-lg p-[4px] flex flex-col gap-[4px] min-w-[220px] z-50"
          style="box-shadow: -2px 2px 24px 0px rgba(0, 0, 0, 0.1)"
        >
          <button
            type="button"
            class="w-full text-left px-3xs py-[8px] rounded-md transition-colors hover:bg-primary-10"
            :disabled="isSaving"
            @click="saveAsSuggestion"
          >
            <div class="font-medium text-size-small leading-[1.4285714285714286em]">
              Save as suggestion
            </div>
            <div class="text-size-extra-small text-neutral-500">
              Create an open suggestion instead of publishing
            </div>
          </button>
        </div>
      </div>

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
