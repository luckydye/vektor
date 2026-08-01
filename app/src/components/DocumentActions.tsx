import { useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import "@atrium-ui/elements/popover";
import { api } from "#api/client.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useDocumentContext } from "#composeables/useDocument.ts";
import { setCancelCount, setEditing, useEditor } from "#composeables/useEditor.ts";
import { useHeaderImage } from "#composeables/useHeaderImage.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { type ActionOptions, Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { Button } from "./Button.tsx";
import { ContextMenu } from "./ContextMenu.tsx";
import { ContextMenuItem } from "./ContextMenuItem.tsx";
import { Contributors } from "./Contributors.tsx";
import { DocumentShareDialog } from "./DocumentShareDialog.tsx";
import { HeaderImageDialog } from "./HeaderImageDialog.tsx";
import type { IconName } from "./Icon.tsx";
import { Icon } from "./Icon.tsx";
import { WorkflowEditorOverlay } from "./WorkflowEditorOverlay.tsx";
import { WorkflowRunButton } from "./WorkflowRunButton.tsx";

interface Props {
  title?: string;
  headerImage?: string | null;
}

export function DocumentActions(props: Props) {
  const navigate = useNavigate();
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
  const { editing, saveStatus, hasChanges } = useEditor();
  const { documentContext, canUseDocumentEditor, hasPublishedVersion } =
    useDocumentContext();
  const toast = useToast();

  const userCanEdit = createMemo(() => documentContext().userCanEdit);
  const userCanManageDocument = createMemo(() => canEdit(currentSpace()?.userRole));
  const documentId = createMemo(() => documentContext().documentId);
  const documentType = createMemo(() => documentContext().documentType);

  const [isCreatingToken, setIsCreatingToken] = createSignal(false);
  const [isDuplicating, setIsDuplicating] = createSignal(false);
  const [showShareDialog, setShowShareDialog] = createSignal(false);
  const [emailMuted, setEmailMuted] = createSignal(false);
  const [emailPreferenceLoaded, setEmailPreferenceLoaded] = createSignal(false);
  const isSaving = createMemo(() => saveStatus() === "saving");
  const publishDisabled = createMemo(() => isSaving());
  const suggestionSaveDisabled = createMemo(() => isSaving() || !hasChanges());
  const isNewDocument = createMemo(() => !documentId());
  const showCancel = createMemo(() => !isNewDocument() && hasPublishedVersion());

  function startEditing() {
    if (!canUseDocumentEditor()) return;
    setEditing(true);
  }

  function openWorkflowEditor() {
    toggleDockedWindow("workflow-editor", {
      side: "right",
      width: 720,
      mode: "floating",
    });
  }

  function openWorkflowEditorFromMenu(e: Event) {
    openWorkflowEditor();
    (e.target as Element | null)?.dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );
  }

  registerScopedAction("document:print", {
    title: t("Print"),
    icon: () => "print",
    description: t("Print current document"),
    group: "document",
    order: 40,
    run: async () => {
      window.print();
    },
  });

  registerScopedAction("document:accesstoken", {
    title: t("Copy API Command"),
    icon: () => "source-code",
    description: t("Creates API token to access this document"),
    group: "document:dev",
    order: 10,
    run: async () => {
      if (isCreatingToken()) return;

      try {
        setIsCreatingToken(true);

        const spaceId = currentSpaceId();
        if (!spaceId) throw new Error("No space selected");

        const docId = documentId();
        if (!docId) return;

        // Create a 30-day access token for this document
        const documentName = props.title || docId;
        const tokenResult = await api.accessTokens.create(spaceId, {
          name: `API Access: ${documentName} (${new Date().toISOString().split("T")[0]})`,
          resourceType: "document",
          resourceId: docId,
          permission: "editor",
          expiresInDays: 30,
        });

        const command = `curl -X PUT ${location.origin}/api/v1/spaces/${spaceId}/documents/${docId} \\
    -H "Content-Type: application/json" \\
    -H "Authorization: Bearer ${tokenResult.token}" \\
    -d '{"content": "<html>Your content here</html>"}'`;

        await navigator.clipboard.writeText(command);

        alert(
          `✓ API command copied to clipboard!\n\nA 30-day access token has been created and included.\nToken ID: ${tokenResult.id}`,
        );
      } catch (error) {
        console.error("Failed to create token:", error);
        alert(
          "❌ Failed to create access token. Please check your permissions and try again.",
        );
      } finally {
        setIsCreatingToken(false);
      }
    },
  });

  registerScopedAction("document:dev:copy-document-id", {
    title: t("Copy Document ID"),
    icon: () => "copy",
    description: t("Copy the current document ID to clipboard"),
    group: "document:dev",
    order: 20,
    run: async () => {
      const docId = documentId();
      if (!docId) return;
      await navigator.clipboard.writeText(docId);
    },
  });

  registerScopedAction("document:dev:copy-space-id", {
    title: t("Copy Space ID"),
    icon: () => "copy",
    description: t("Copy the current space ID to clipboard"),
    group: "document:dev",
    order: 30,
    run: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) return;
      await navigator.clipboard.writeText(spaceId);
    },
  });

  const [actions, setActions] = createSignal<[string, ActionOptions][]>([]);
  const [actionsDanger, setActionsDanger] = createSignal<[string, ActionOptions][]>([]);
  const [actionsDev, setActionsDev] = createSignal<[string, ActionOptions][]>([]);
  const [devMode, setDevMode] = createSignal(false);

  async function publishDocument(e: MouseEvent) {
    const action = Actions.get("document:save:publish");
    if (!action) return;
    await action.run();
    (e.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
  }

  function cancelEditing() {
    setEditing(false);
    setCancelCount((count) => count + 1);
    if (!documentId()) window.history.back();
  }

  async function saveAsSuggestion(e: MouseEvent) {
    const action = Actions.get("document:save:suggestion");
    if (!action) return;
    await action.run();
    (e.target as Element)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
  }

  function handleContextMenuMousedown(event: MouseEvent) {
    setDevMode(event.altKey || event.metaKey);
    if (devMode()) setActionsDev(Actions.group("document:dev"));
  }

  function refreshActionGroups() {
    setActions(Actions.group("document"));
    setActionsDanger(Actions.group("document:danger"));
  }

  registerScopedAction("document:edit", {
    title: t("Edit Document"),
    description: t("Start editing mode for current document"),
    group: "edit",
    run: async () => startEditing(),
  });

  registerScopedAction("document:cancel", {
    title: t("Cancel Editing"),
    description: t("Discard editing mode for current document"),
    group: "edit",
    run: async () => {
      if (editing()) cancelEditing();
    },
  });

  onMount(() => {
    onCleanup(Actions.subscribe("actions:register", refreshActionGroups));
    onCleanup(Actions.subscribe("actions:unregister", refreshActionGroups));

    refreshActionGroups();
  });

  function runContextMenuAction(e: Event, name: string) {
    Actions.run(name);
    (e.target as Element | null)?.dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );
  }

  createEffect(() => {
    const spaceId = currentSpaceId();
    const currentDocumentId = documentId();
    setEmailPreferenceLoaded(false);
    if (!spaceId || !currentDocumentId || !currentUser()) return;

    let current = true;
    void api.space
      .getNotificationPreference(spaceId, currentDocumentId)
      .then(({ muted }) => {
        if (!current) return;
        setEmailMuted(muted);
        setEmailPreferenceLoaded(true);
      })
      .catch((error) => console.error("Failed to load document email preference", error));

    onCleanup(() => {
      current = false;
    });
  });

  createEffect(() => {
    const spaceId = currentSpaceId();
    const currentDocumentId = documentId();
    if (!spaceId || !currentDocumentId || !emailPreferenceLoaded()) return;

    const muted = emailMuted();
    const actionName = muted ? "document:unmute-email" : "document:mute-email";
    registerScopedAction(actionName, {
      title: muted ? "Enable email notifications" : "Mute email notifications",
      icon: () => (muted ? "enable-notifications" : "mute-notifications"),
      description: muted
        ? "Receive publication and comment emails for this document"
        : "Stop publication and comment emails for this document",
      group: "document",
      order: 35,
      run: async () => {
        const response = await api.space.setNotificationMuted(
          spaceId,
          !muted,
          currentDocumentId,
        );
        setEmailMuted(response.muted);
      },
    });
  });

  createEffect(() => {
    const space = currentSpace();
    const docId = documentId();
    if (!userCanManageDocument() || !space || !docId) return;

    const isPinned = space.preferences?.pinnedDocumentId === docId;

    if (isPinned) {
      registerScopedAction("document:unpin", {
        title: t("Unpin from Home"),
        icon: () => "pin-to-home",
        description: t("Remove this document from the space home page"),
        group: "document",
        order: 20,
        run: async () => {
          await api.space.patch(space.id, { preferences: { pinnedDocumentId: "" } });
          window.location.reload();
        },
      });
      return;
    }

    registerScopedAction("document:pin", {
      title: t("Pin to Home"),
      icon: () => "pin-to-home",
      description: t("Showcase this document on the space home page"),
      group: "document",
      order: 20,
      run: async () => {
        await api.space.patch(space.id, { preferences: { pinnedDocumentId: docId } });
        window.location.reload();
      },
    });
  });

  createEffect(() => {
    const spaceId = currentSpaceId();
    const currentDocumentId = documentId();
    if (!userCanManageDocument() || !spaceId || !currentDocumentId) return;

    registerScopedAction("document:duplicate", {
      title: t("Duplicate Document"),
      icon: () => "copy",
      description: t("Create a new document with this document's content"),
      group: "document",
      order: 25,
      run: async () => {
        if (isDuplicating()) return;

        setIsDuplicating(true);
        try {
          const source = await api.document.get(spaceId, currentDocumentId);
          const duplicate = await api.documents.post(spaceId, {
            content: source.content,
            ...(source.type ? { type: source.type } : {}),
          });
          navigate(`/doc/${duplicate.slug}`);
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : t("Failed to duplicate document"),
          );
        } finally {
          setIsDuplicating(false);
        }
      },
    });
  });

  createEffect(() => {
    if (userCanManageDocument() !== true || !documentId()) return;

    registerScopedAction("document:archive", {
      title: t("Archive Document"),
      icon: () => "archive-document",
      description: t("Archive current document"),
      group: "document:danger",
      order: 20,
      run: async () => {
        if (!confirm("Are you sure you want to archive this document?")) return;

        const spaceId = currentSpaceId();
        if (!spaceId) throw new Error("No space selected");
        if (!currentSpace()) throw new Error("No space loaded");

        const docId = documentId();
        if (!docId) return;

        await api.document.archive(spaceId, docId);

        navigate("/");
      },
    });
  });

  createEffect(() => {
    if (!userCanManageDocument() || !documentId() || !hasPublishedVersion()) return;

    registerScopedAction("document:unpublish", {
      title: t("Unpublish"),
      icon: () => "eye",
      description: t("Remove the published version of this document"),
      group: "document:danger",
      order: 30,
      run: async () => {
        if (!confirm("Are you sure you want to unpublish this document?")) return;

        const spaceId = currentSpaceId();
        if (!spaceId) throw new Error("No space selected");
        const docId = documentId();
        if (!docId) return;

        await api.document.patch(spaceId, docId, { publishedRev: null });
      },
    });
  });

  createEffect(() => {
    if (!userCanManageDocument() || !documentId()) return;

    registerScopedAction("document:share", {
      title: t("Share"),
      icon: () => "users-group",
      description: t("Invite people to this document or space"),
      group: "document",
      order: 10,
      run: async () => {
        setShowShareDialog(true);
      },
    });
  });

  createEffect(() => {
    const currentDocumentId = documentId();
    if (
      userCanManageDocument() !== true ||
      !currentDocumentId ||
      !supportsHeaderImage(documentType())
    ) {
      return;
    }

    registerScopedAction("document:set-header", {
      title: props.headerImage ? t("Change header") : t("Add header image"),
      icon: () => "header-image",
      description: t("Set the header image for this document"),
      group: "document",
      order: 30,
      run: async () => changeHeaderImage(currentDocumentId),
    });

    if (props.headerImage) {
      registerScopedAction("document:remove-header", {
        title: t("Remove header image"),
        icon: () => "image",
        description: t("Remove the header image from this document"),
        group: "document:danger",
        order: 10,
        run: async () => removeHeaderImage(currentDocumentId),
      });
    }
  });

  // Extensions name their own icons, and an unknown name draws nothing rather
  // than a stand-in glyph that means something else.
  const actionIcon = (options: ActionOptions): IconName | undefined =>
    options.icon?.() as IconName | undefined;

  return (
    <div
      id="document-actions"
      class="pointer-events-auto flex flex-none items-start gap-4xs"
    >
      <div class="mr-3 flex-1">
        <Show when={documentId()}>{(id) => <Contributors documentId={id()} />}</Show>
      </div>

      <Show
        when={
          documentType() === "workflow" &&
          documentId() &&
          currentSpaceId() &&
          userCanEdit()
        }
      >
        <WorkflowRunButton
          documentId={documentId() as string}
          spaceId={currentSpaceId() as string}
        />
      </Show>

      {/* Workflows have no dedicated edit button; the context menu carries it. */}

      <Show when={canUseDocumentEditor() && !editing()}>
        <button
          type="button"
          class="button-primary px-3 max-md:hidden"
          onClick={startEditing}
        >
          <Icon name="edit-document" />
          <span>Edit</span>
        </button>
      </Show>

      <Show when={documentType() === "workflow" && documentId() && currentSpaceId()}>
        <WorkflowEditorOverlay
          documentId={documentId() as string}
          spaceId={currentSpaceId() as string}
        />
      </Show>

      <Show when={canUseDocumentEditor() && editing()}>
        <div class="flex items-center gap-2">
          <div class="button-primary-base button-with-icon items-stretch overflow-hidden">
            <button
              type="button"
              class="button-primary-pointer inline-flex items-center justify-center px-3xs"
              disabled={publishDisabled()}
              onClick={(e) => void publishDocument(e)}
            >
              <Icon name="publish" />
              <span>
                {isSaving() ? "Saving..." : isNewDocument() ? "Create" : "Publish"}
              </span>
            </button>
            <Show when={!isNewDocument()}>
              <a-popover-trigger class="group flex items-stretch">
                <button
                  slot="trigger"
                  type="button"
                  class="button-primary-pointer flex items-center justify-center border-primary-300 border-l px-4xs"
                  disabled={isSaving()}
                  aria-label="Publish options"
                >
                  <Icon name="chevron-down" />
                </button>
                <a-popover class="group" placements="bottom-end">
                  <div class="mt-2 w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
                    <div
                      class="flex w-[220px] flex-col gap-[4px] rounded-lg border border-neutral-100 bg-background p-[4px]"
                      style={{ "box-shadow": "-2px 2px 24px 0px rgba(0, 0, 0, 0.1)" }}
                    >
                      <button
                        type="button"
                        class="w-full rounded-md px-3xs py-[8px] text-left transition-colors hover:bg-primary-10"
                        disabled={suggestionSaveDisabled()}
                        onClick={(e) => void saveAsSuggestion(e)}
                      >
                        <div class="font-medium text-size-small">Save as suggestion</div>
                        <div class="text-neutral-500 text-size-small">
                          Create an open suggestion instead of publishing
                        </div>
                      </button>
                    </div>
                  </div>
                </a-popover>
              </a-popover-trigger>
            </Show>
          </div>

          <Show when={showCancel()}>
            <Button variant="secondary" onClick={cancelEditing}>
              <Icon name="cancel" />
              <span>Cancel</span>
            </Button>
          </Show>
        </div>
      </Show>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: mousedown only reads the modifier keys that unlock the dev actions; the menu inside is the control. */}
      <div class="relative flex-none" onMouseDown={handleContextMenuMousedown}>
        <HeaderImageDialog
          show={dialogOpen()}
          onSelect={(file) => {
            const id = documentId();
            if (id) void uploadHeaderImage(id, file);
          }}
        />
        <Show when={documentId()}>
          {(id) => (
            <DocumentShareDialog
              show={showShareDialog()}
              onUpdateShow={setShowShareDialog}
              documentId={id()}
              documentTitle={props.title}
            />
          )}
        </Show>
        <ContextMenu>
          <Show when={documentType() === "workflow" && documentId() && userCanEdit()}>
            <ContextMenuItem onClick={openWorkflowEditorFromMenu}>
              <div class="aspect-sqaure w-[1rem] flex-none">
                <Icon name="edit-document" class="align-middle" />
              </div>
              <span class="mr-2 block w-full text-left">{t("Edit")}</span>
            </ContextMenuItem>
          </Show>

          <Show when={canUseDocumentEditor() && !editing()}>
            <ContextMenuItem
              class="md:hidden"
              onClick={(event) => runContextMenuAction(event, "document:edit")}
            >
              <div class="aspect-sqaure w-[1rem] flex-none">
                <Icon name="edit-document" class="align-middle" />
              </div>
              <span class="mr-2 block w-full text-left">{t("Edit")}</span>
            </ContextMenuItem>
          </Show>

          <For each={actions()}>
            {([name, options]) => (
              <ContextMenuItem onClick={(event) => runContextMenuAction(event, name)}>
                <div class="aspect-sqaure w-[1rem] flex-none">
                  <Icon name={actionIcon(options)} class="align-middle" />
                </div>
                <span class="mr-2 block w-full text-left" data-action={name}>
                  {options.title}
                </span>
                <a-shortcut
                  attr:data-shortcut={
                    Actions.getShortcutsForAction(name)?.values().next().value
                  }
                />
              </ContextMenuItem>
            )}
          </For>

          <For each={actionsDanger()}>
            {([name, options]) => (
              <ContextMenuItem
                onClick={(event) => runContextMenuAction(event, name)}
                class="text-orange-600 hover:text-orange-700"
              >
                <div class="aspect-sqaure w-[1rem] flex-none">
                  <Icon name={actionIcon(options)} class="align-middle" />
                </div>
                <span>{options.title}</span>
              </ContextMenuItem>
            )}
          </For>

          <Show when={devMode()}>
            <For each={actionsDev()}>
              {([name, options]) => (
                <ContextMenuItem
                  onClick={(event) => runContextMenuAction(event, name)}
                  class="text-neutral-400"
                >
                  <div class="aspect-sqaure w-[1rem] flex-none">
                    <Icon name={actionIcon(options)} class="align-middle" />
                  </div>
                  <span>{options.title}</span>
                </ContextMenuItem>
              )}
            </For>
          </Show>
        </ContextMenu>
      </div>
    </div>
  );
}
