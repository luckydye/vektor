<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import { useRouter } from "vue-router";
import "@atrium-ui/elements/popover";
import { api } from "#api/client.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useDocumentContext } from "#composeables/useDocument.ts";
import { useEditor } from "#composeables/useEditor.ts";
import { useHeaderImage } from "#composeables/useHeaderImage.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { type ActionOptions, Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import {
  ButtonSecondary,
  ContextMenu,
  ContextMenuItem,
  Icon,
} from "~/src/components/index.ts";
import Contributors from "./Contributors.vue";
import DocumentShareDialog from "./DocumentShareDialog.vue";
import HeaderImageDialog from "./HeaderImageDialog.vue";
import WorkflowEditorOverlay from "./WorkflowEditorOverlay.vue";
import WorkflowRunButton from "./WorkflowRunButton.vue";

const props = defineProps<{
  title?: string;
  headerImage?: string;
}>();

const router = useRouter();
const { currentSpaceId, currentSpace } = useSpace();
const currentUser = useUserProfile();
const { toggle: toggleDockedWindow } = useDockedWindows();
const {
  supportsHeaderImage,
  changeHeaderImage,
  uploadHeaderImage,
  removeHeaderImage,
  dialogOpen,
} = useHeaderImage();
const { cancelCount, editing, saveStatus, hasChanges } = useEditor();
const { documentContext, canUseDocumentEditor, hasPublishedVersion } =
  useDocumentContext();

const userCanEdit = computed(() => documentContext.value.userCanEdit);
const userCanManageDocument = computed(() => canEdit(currentSpace.value?.userRole));
const documentId = computed(() => documentContext.value.documentId);
const documentType = computed(() => documentContext.value.documentType);

const isCreatingToken = ref(false);
const showShareDialog = ref(false);
const emailMuted = ref(false);
const emailPreferenceLoaded = ref(false);
const isSaving = computed(() => saveStatus.value === "saving");
const publishDisabled = computed(() => isSaving.value);
const suggestionSaveDisabled = computed(() => isSaving.value || !hasChanges.value);
const isNewDocument = computed(() => !documentId.value);
const showCancel = computed(() => !isNewDocument.value && hasPublishedVersion.value);

function registerEditAction() {
  Actions.register("document:edit", {
    title: t("Edit Document"),
    description: t("Start editing mode for current document"),
    group: "edit",
    run: async () => startEditing(),
  });
}

function registerCancelAction() {
  Actions.register("document:cancel", {
    title: t("Cancel Editing"),
    description: t("Discard editing mode for current document"),
    group: "edit",
    run: async () => {
      if (editing.value) {
        cancelEditing();
      }
    },
  });
}

function startEditing() {
  if (!canUseDocumentEditor.value) {
    return;
  }

  editing.value = true;
}

function openWorkflowEditor() {
  toggleDockedWindow("workflow-editor", { side: "right", width: 720, mode: "floating" });
}

function openWorkflowEditorFromMenu(e: Event) {
  openWorkflowEditor();
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

Actions.register("document:print", {
  title: t("Print"),
  icon: () => "print",
  description: t("Print current document"),
  group: "document",
  order: 40,
  run: async () => {
    window.print();
  },
});

Actions.register("document:accesstoken", {
  title: t("Copy API Command"),
  icon: () => "source-code",
  description: t("Creates API token to access this document"),
  group: "document:dev",
  order: 10,
  run: async () => {
    if (isCreatingToken.value) return;

    try {
      isCreatingToken.value = true;

      if (!currentSpaceId.value) {
        throw new Error("No space selected");
      }

      if (!documentId.value) {
        return;
      }

      // Create a 30-day access token for this document
      const documentName = props.title || documentId.value;
      const tokenResult = await api.accessTokens.create(currentSpaceId.value, {
        name: `API Access: ${documentName} (${new Date().toISOString().split("T")[0]})`,
        resourceType: "document",
        resourceId: documentId.value,
        permission: "editor",
        expiresInDays: 30,
      });

      const command = `curl -X PUT ${location.origin}/api/v1/spaces/${currentSpaceId.value}/documents/${documentId.value} \\
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

async function publishDocument(e: MouseEvent) {
  const action = Actions.get("document:save:publish");
  if (!action) return;
  await action.run();
  (e.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

function cancelEditing() {
  editing.value = false;
  cancelCount.value++;
  if (!documentId.value) {
    window.history.back();
  }
}

async function saveAsSuggestion(e: MouseEvent) {
  const action = Actions.get("document:save:suggestion");
  if (!action) return;
  await action.run();
  (e.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

Actions.register("document:dev:copy-document-id", {
  title: t("Copy Document ID"),
  icon: () => "copy",
  description: t("Copy the current document ID to clipboard"),
  group: "document:dev",
  order: 20,
  run: async () => {
    if (!documentId.value) return;
    await navigator.clipboard.writeText(documentId.value);
  },
});

Actions.register("document:dev:copy-space-id", {
  title: t("Copy Space ID"),
  icon: () => "copy",
  description: t("Copy the current space ID to clipboard"),
  group: "document:dev",
  order: 30,
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
  registerEditAction();
  registerCancelAction();

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
  Actions.unregister("document:edit");
  Actions.unregister("document:cancel");
  Actions.unregister("document:share");
  Actions.unregister("document:mute-email");
  Actions.unregister("document:unmute-email");
});

function runContextMenuAction(e: Event, name: string) {
  Actions.run(name);
  e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

watchEffect((onCleanup) => {
  const spaceId = currentSpaceId.value;
  const currentDocumentId = documentId.value;
  emailPreferenceLoaded.value = false;
  if (!spaceId || !currentDocumentId || !currentUser.value) return;

  let current = true;
  void api.document
    .getEmailPreference(spaceId, currentDocumentId)
    .then(({ muted }) => {
      if (!current) return;
      emailMuted.value = muted;
      emailPreferenceLoaded.value = true;
    })
    .catch((error) => console.error("Failed to load document email preference", error));

  onCleanup(() => {
    current = false;
  });
});

watchEffect(() => {
  Actions.unregister("document:mute-email");
  Actions.unregister("document:unmute-email");

  const spaceId = currentSpaceId.value;
  const currentDocumentId = documentId.value;
  if (!spaceId || !currentDocumentId || !emailPreferenceLoaded.value) return;

  const muted = emailMuted.value;
  const actionName = muted ? "document:unmute-email" : "document:mute-email";
  Actions.register(actionName, {
    title: muted ? "Enable email notifications" : "Mute email notifications",
    icon: () => (muted ? "enable-notifications" : "mute-notifications"),
    description: muted
      ? "Receive publication and comment emails for this document"
      : "Stop publication and comment emails for this document",
    group: "document",
    order: 35,
    run: async () => {
      const response = await api.document.setEmailMuted(
        spaceId,
        currentDocumentId,
        !muted,
      );
      emailMuted.value = response.muted;
    },
  });
});

watchEffect(() => {
  Actions.unregister("document:pin");
  Actions.unregister("document:unpin");

  if (userCanManageDocument.value && currentSpace.value && documentId.value) {
    const isPinned =
      currentSpace.value.preferences?.pinnedDocumentId === documentId.value;

    if (isPinned) {
      Actions.register("document:unpin", {
        title: t("Unpin from Home"),
        icon: () => "pin-filled",
        description: t("Remove this document from the space home page"),
        group: "document",
        order: 20,
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
        order: 20,
        run: async () => {
          const spaceId = currentSpace.value?.id;
          if (!spaceId || !documentId.value) return;

          await api.space.patch(spaceId, {
            preferences: { pinnedDocumentId: documentId.value },
          });
          window.location.reload();
        },
      });
    }
  }
});

watchEffect(() => {
  Actions.unregister("document:archive");

  if (userCanManageDocument.value === true) {
    Actions.register("document:archive", {
      title: t("Archive Document"),
      icon: () => "archive",
      description: t("Archive current document"),
      group: "document:danger",
      order: 20,
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

        if (!documentId.value) {
          return;
        }

        await api.document.archive(currentSpaceId.value, documentId.value);

        router.push("/");
      },
    });
  }
});

watchEffect(() => {
  Actions.unregister("document:unpublish");

  if (userCanManageDocument.value && documentId.value && hasPublishedVersion.value) {
    Actions.register("document:unpublish", {
      title: t("Unpublish"),
      icon: () => "eye",
      description: t("Remove the published version of this document"),
      group: "document:danger",
      order: 30,
      run: async () => {
        if (!confirm("Are you sure you want to unpublish this document?")) {
          return;
        }

        if (!currentSpaceId.value) {
          throw new Error("No space selected");
        }
        if (!documentId.value) {
          return;
        }

        await api.document.patch(currentSpaceId.value, documentId.value, {
          publishedRev: null,
        });
      },
    });
  }
});

watchEffect(() => {
  Actions.unregister("document:share");

  if (userCanManageDocument.value && documentId.value) {
    Actions.register("document:share", {
      title: t("Share"),
      icon: () => "share",
      description: t("Invite people to this document or space"),
      group: "document",
      order: 10,
      run: async () => {
        showShareDialog.value = true;
      },
    });
  }
});

watchEffect(() => {
  Actions.unregister("document:set-header");
  Actions.unregister("document:remove-header");

  const currentDocumentId = documentId.value;
  if (
    userCanManageDocument.value === true &&
    currentDocumentId &&
    supportsHeaderImage(documentType.value)
  ) {
    Actions.register("document:set-header", {
      title: props.headerImage ? t("Change header") : t("Add header image"),
      icon: () => "header-image",
      description: t("Set the header image for this document"),
      group: "document",
      order: 30,
      run: async () => changeHeaderImage(currentDocumentId),
    });

    if (props.headerImage) {
      Actions.register("document:remove-header", {
        title: t("Remove header image"),
        icon: () => "image",
        description: t("Remove the header image from this document"),
        group: "document:danger",
        order: 10,
        run: async () => removeHeaderImage(currentDocumentId),
      });
    }
  }
});
</script>

<template>
  <div
    id="document-actions"
    class="flex gap-4xs items-start flex-none pointer-events-auto"
  >
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
      class="button-primary px-3 max-md:hidden"
      @click="openWorkflowEditor"
    >
      <Icon name="edit" />
      <span>Edit</span>
    </button>

    <button
      v-if="canUseDocumentEditor && !editing"
      type="button"
      class="button-primary px-3 max-md:hidden"
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

    <div v-if="canUseDocumentEditor && editing" class="flex items-center gap-2">
      <div class="button-primary-base button-with-icon overflow-hidden items-stretch">
        <button
          type="button"
          class="inline-flex justify-center items-center px-3xs button-primary-pointer"
          :disabled="publishDisabled"
          @click="publishDocument"
        >
          <Icon name="publish" />
          <span>{{ isSaving ? "Saving..." : isNewDocument ? "Create" : "Publish" }}</span>
        </button>
        <a-popover-trigger v-if="!isNewDocument" class="flex items-stretch group">
          <button
            slot="trigger"
            type="button"
            class="flex items-center justify-center border-l border-primary-300 px-4xs button-primary-pointer"
            :disabled="isSaving"
            aria-label="Publish options"
          >
            <Icon name="chevron-down" />
          </button>
          <a-popover class="group" placements="bottom-end">
            <div
              class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100 mt-2"
            >
              <div
                class="bg-background border border-neutral-100 rounded-lg p-[4px] flex flex-col gap-[4px] w-[220px]"
                style="box-shadow: -2px 2px 24px 0px rgba(0, 0, 0, 0.1)"
              >
                <button
                  type="button"
                  class="w-full text-left px-3xs py-[8px] rounded-md transition-colors hover:bg-primary-10"
                  :disabled="suggestionSaveDisabled"
                  @click="saveAsSuggestion"
                >
                  <div class="font-medium text-size-small">Save as suggestion</div>
                  <div class="text-size-small text-neutral-500">
                    Create an open suggestion instead of publishing
                  </div>
                </button>
              </div>
            </div>
          </a-popover>
        </a-popover-trigger>
      </div>

      <ButtonSecondary v-if="showCancel" @click="cancelEditing">
        <Icon name="cancel" />
        <span>Cancel</span>
      </ButtonSecondary>
    </div>

    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <div class="relative flex-none" @mousedown="handleContextMenuMousedown">
      <HeaderImageDialog
        v-model:show="dialogOpen"
        @select="(file) => documentId && uploadHeaderImage(documentId, file)"
      />
      <DocumentShareDialog
        v-if="documentId"
        v-model:show="showShareDialog"
        :documentId="documentId"
        :documentTitle="title"
      />
      <ContextMenu>
        <ContextMenuItem
          v-if="documentType === 'workflow' && documentId && userCanEdit"
          class="md:hidden"
          :onClick="openWorkflowEditorFromMenu"
        >
          <div class="aspect-sqaure flex-none w-[1rem]">
            <Icon name="edit" />
          </div>
          <span class="block w-full text-left mr-2">{{ t("Edit") }}</span>
        </ContextMenuItem>

        <ContextMenuItem
          v-if="canUseDocumentEditor && !editing"
          class="md:hidden"
          :onClick="(event) => runContextMenuAction(event, 'document:edit')"
        >
          <div class="aspect-sqaure flex-none w-[1rem]">
            <Icon name="edit" />
          </div>
          <span class="block w-full text-left mr-2">{{ t("Edit") }}</span>
        </ContextMenuItem>

        <ContextMenuItem
          v-for="[ name, options ] of actions"
          :onClick="(event) => runContextMenuAction(event, name)"
        >
          <div class="aspect-sqaure flex-none w-[1rem]">
            <Icon :name="(options.icon?.() as any) || 'placeholder'" />
          </div>
          <span class="block w-full text-left mr-2" :data-action="name"
            >{{ options.title }}</span
          >
          <a-shortcut
            :data-shortcut="Actions.getShortcutsForAction(name)?.values().next().value"
          ></a-shortcut>
        </ContextMenuItem>

        <ContextMenuItem
          v-for="[ name, options ] of actionsDanger"
          :onClick="(event) => runContextMenuAction(event, name)"
          class="text-orange-600 hover:text-orange-700"
        >
          <div class="aspect-sqaure flex-none w-[1rem]">
            <Icon :name="(options.icon?.() as any) || 'placeholder'" />
          </div>
          <span>{{ options.title }}</span>
        </ContextMenuItem>

        <template v-if="devMode">
          <ContextMenuItem
            v-for="[ name, options ] of actionsDev"
            :onClick="(event) => runContextMenuAction(event, name)"
            class="text-neutral-400"
          >
            <div class="aspect-sqaure flex-none w-[1rem]">
              <Icon :name="(options.icon?.() as any) || 'placeholder'" />
            </div>
            <span>{{ options.title }}</span>
          </ContextMenuItem>
        </template>
      </ContextMenu>
    </div>
  </div>
</template>
