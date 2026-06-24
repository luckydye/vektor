<script setup lang="ts">
import { computed, onMounted, ref, watch, watchEffect } from "vue";
import "@sv/elements/popover";
import {
  ButtonSecondary,
  ContextMenu,
  ContextMenuItem,
  Icon,
} from "~/src/components/index.ts";
import { api } from "../api/client.ts";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";
import { useEditor } from "../composeables/useEditor.ts";
import { useHeaderImage } from "../composeables/useHeaderImage.ts";
import { canEdit } from "../composeables/usePermissions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { type ActionOptions, Actions } from "../utils/actions.ts";
import { t } from "../utils/lang.ts";
import Contributors from "./Contributors.vue";
import HeaderImageDialog from "./HeaderImageDialog.vue";
import WorkflowEditorOverlay from "./WorkflowEditorOverlay.vue";
import WorkflowRunButton from "./WorkflowRunButton.vue";

const props = defineProps<{
  documentId?: string;
  title?: string;
  readonly: boolean;
  documentType?: string;
  headerImage?: string;
}>();

const { currentSpaceId, currentSpace } = useSpace();
const { toggle: toggleDockedWindow } = useDockedWindows();
const {
  supportsHeaderImage,
  changeHeaderImage,
  uploadHeaderImage,
  removeHeaderImage,
  dialogOpen,
} = useHeaderImage();
const { cancelCount, editing, saveStatus, hasChanges } = useEditor();

const userCanEdit = computed(() => {
  return canEdit(currentSpace.value?.userRole);
});

const isCreatingToken = ref(false);
const isSaving = computed(() => saveStatus.value === "saving");
const saveDisabled = computed(() => isSaving.value || !hasChanges.value);

function registerEditAction() {
  Actions.register("document:edit", {
    title: t("Edit Document"),
    description: t("Start editing mode for current document"),
    group: "edit",
    run: async () => startEditing(),
  });
}

function syncEditActions(isEditing = editing.value) {
  if (isEditing) {
    Actions.unregister("document:edit");
  } else {
    registerEditAction();
  }
}

function startEditing() {
  if (props.readonly || !userCanEdit.value) {
    return;
  }

  editing.value = true;
  syncEditActions(true);
}

watch(editing, syncEditActions, { immediate: true });

function markdownDownloadName() {
  const name = (props.title || "document")
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/g, "");

  return `${name || "document"}.md`;
}

Actions.register("document:print", {
  title: t("Print"),
  icon: () => "print",
  description: t("Print current document"),
  group: "document",
  run: async () => {
    window.print();
  },
});

Actions.register("document:export", {
  title: t("Export"),
  icon: () => "download",
  description: t("Export current document to markdown"),
  group: "document",
  run: async () => {
    const response = await fetch(location.href, {
      headers: { Accept: "text/markdown" },
    });
    if (!response.ok) {
      throw new Error(`Failed to export document (${response.status})`);
    }

    const downloadUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = markdownDownloadName();
    link.click();
    setTimeout(() => URL.revokeObjectURL(downloadUrl));
  },
});

Actions.register("document:accesstoken", {
  title: t("Copy API Command"),
  icon: () => "webhook",
  description: t("Creates API token to access this document"),
  group: "document:dev",
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
const actionsDev = ref<[string, ActionOptions][]>([]);
const devMode = ref(false);

function stopEditing() {
  if (!editing.value) return;
  if (!Actions.get("document:save")) return;
  Actions.run("document:save");
}

function publishDocument(e: MouseEvent) {
  if (!Actions.get("document:save:publish")) return;
  Actions.run("document:save:publish");
  (e.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

function cancelEditing() {
  editing.value = false;
  cancelCount.value++;
  if (props.documentId) {
    syncEditActions(false);
  } else {
    window.history.back();
  }
}

function saveAsSuggestion(e: MouseEvent) {
  if (!Actions.get("document:save:suggestion")) return;
  Actions.run("document:save:suggestion");
  (e.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

Actions.register("document:dev:copy-document-id", {
  title: t("Copy Document ID"),
  icon: () => "copy",
  description: t("Copy the current document ID to clipboard"),
  group: "document:dev",
  run: async () => {
    if (!props.documentId) return;
    await navigator.clipboard.writeText(props.documentId);
  },
});

Actions.register("document:dev:copy-space-id", {
  title: t("Copy Space ID"),
  icon: () => "copy",
  description: t("Copy the current space ID to clipboard"),
  group: "document:dev",
  run: async () => {
    if (!currentSpaceId.value) return;
    await navigator.clipboard.writeText(currentSpaceId.value);
  },
});

function handleContextMenuMousedown(event: MouseEvent) {
  devMode.value = event.altKey || event.metaKey;
  if (devMode.value) {
    actionsDev.value = Actions.group("document:dev");
  }
}

onMounted(async () => {
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
        title: t("Unpin from Home"),
        icon: () => "pin-filled",
        description: t("Remove this document from the space home page"),
        group: "document",
        run: async () => {
          const spaceId = currentSpace.value?.id;
          if (!spaceId) return;

          await api.space.patch(spaceId, {
            preferences: { pinnedDocumentId: "" },
          });
          window.location.reload();
        },
      });
    } else {
      Actions.register("document:pin", {
        title: t("Pin to Home"),
        icon: () => "pin",
        description: t("Showcase this document on the space home page"),
        group: "document",
        run: async () => {
          const spaceId = currentSpace.value?.id;
          const documentId = props.documentId;
          if (!spaceId || !documentId) return;

          await api.space.patch(spaceId, {
            preferences: { pinnedDocumentId: documentId },
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
      title: t("Archive Document"),
      icon: () => "archive",
      description: t("Archive current document"),
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

watchEffect(() => {
  Actions.unregister("document:set-header");
  Actions.unregister("document:remove-header");

  const documentId = props.documentId;
  if (
    userCanEdit.value === true &&
    documentId &&
    supportsHeaderImage(props.documentType)
  ) {
    Actions.register("document:set-header", {
      title: props.headerImage ? t("Change header") : t("Add header image"),
      icon: () => "image",
      description: t("Set the header image for this document"),
      group: "document",
      run: async () => changeHeaderImage(documentId),
    });

    if (props.headerImage) {
      Actions.register("document:remove-header", {
        title: t("Remove header image"),
        icon: () => "image",
        description: t("Remove the header image from this document"),
        group: "document:danger",
        run: async () => removeHeaderImage(documentId),
      });
    }
  }
});
</script>

<template>
  <div id="document-actions" class="flex gap-4xs items-start flex-none">
    <div class="flex-1 mr-3">
      <Contributors v-if="documentId" :documentId="documentId" />
    </div>

    <WorkflowRunButton
      v-if="documentType === 'workflow' && documentId && currentSpaceId && userCanEdit"
      :documentId="documentId"
      :spaceId="currentSpaceId"
    />

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
      v-if="!editing && !readonly && userCanEdit"
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

    <div v-if="editing" class="flex items-center gap-2">
      <div class="button-primary-base button-with-icon overflow-hidden items-stretch">
        <button
          type="button"
          class="inline-flex justify-center items-center px-3xs button-primary-pointer"
          :disabled="saveDisabled"
          @click="publishDocument"
        >
          <Icon name="check" />
          <span>{{ isSaving ? "Saving..." : "Publish" }}</span>
        </button>
        <a-popover-trigger v-if="documentId" class="flex items-stretch group">
          <button
            slot="trigger"
            type="button"
            class="flex items-center justify-center border-l border-primary-700 px-4xs button-primary-pointer"
            :disabled="saveDisabled"
            aria-label="Save options"
          >
            <Icon name="chevron-down" />
          </button>
          <a-popover class="group" placements="bottom-end">
            <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
              <div
                class="bg-background border border-neutral-100 rounded-lg p-[4px] flex flex-col gap-[4px] min-w-[220px]"
                style="box-shadow: -2px 2px 24px 0px rgba(0, 0, 0, 0.1)"
              >
                <button
                  type="button"
                  class="w-full text-left px-3xs py-[8px] rounded-md transition-colors hover:bg-primary-10"
                  :disabled="saveDisabled"
                  @click="stopEditing"
                >
                  <div class="font-medium text-size-small">Save</div>
                  <div class="text-size-small text-neutral-500">Save without publishing to viewers</div>
                </button>
                <button
                  type="button"
                  class="w-full text-left px-3xs py-[8px] rounded-md transition-colors hover:bg-primary-10"
                  :disabled="saveDisabled"
                  @click="saveAsSuggestion"
                >
                  <div class="font-medium text-size-small">Save as suggestion</div>
                  <div class="text-size-small text-neutral-500">Create an open suggestion instead of publishing</div>
                </button>
              </div>
            </div>
          </a-popover>
        </a-popover-trigger>
      </div>

      <ButtonSecondary @click="cancelEditing">
        <Icon name="close" />
        <span>Cancel</span>
      </ButtonSecondary>
    </div>

    <div class="relative flex-none" @mousedown="handleContextMenuMousedown">
      <HeaderImageDialog
        v-model:show="dialogOpen"
        @select="(file) => props.documentId && uploadHeaderImage(props.documentId, file)"
      />
      <ContextMenu>
      <ContextMenuItem v-for="[name, options] of actions" :onClick="(event) => runContextMenuAction(event, name)">
        <div class="aspect-sqaure flex-none w-[1rem]">
            <Icon :name="(options.icon?.() as any) || 'placeholder'" />
        </div>
        <span class="block w-full text-left mr-2" :data-action="name">{{options.title}}</span>
        <a-shortcut :data-shortcut="Actions.getShortcutsForAction(name)?.values().next().value"></a-shortcut>
      </ContextMenuItem>

      <hr v-if="actionsDanger.length > 0" />

      <ContextMenuItem v-for="[name, options] of actionsDanger" :onClick="(event) => runContextMenuAction(event, name)" class="text-orange-600 hover:text-orange-700">
        <div class="aspect-sqaure flex-none w-[1rem]">
            <Icon :name="(options.icon?.() as any) || 'placeholder'" />
        </div>
        <span>{{options.title}}</span>
      </ContextMenuItem>

      <template v-if="devMode">
        <hr />
        <ContextMenuItem v-for="[name, options] of actionsDev" :onClick="(event) => runContextMenuAction(event, name)" class="text-neutral-400">
          <div class="aspect-sqaure flex-none w-[1rem]">
              <Icon :name="(options.icon?.() as any) || 'placeholder'" />
          </div>
          <span>{{options.title}}</span>
        </ContextMenuItem>
      </template>
    </ContextMenu>
    </div>
  </div>
</template>
