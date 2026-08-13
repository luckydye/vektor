import { createEffect, createSignal, Show } from "solid-js";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { sanitizeSvgMarkup } from "#utils/html.ts";
import {
  isWorkflowCreationEnabled,
  spacePreferenceKeys,
} from "#utils/spacePreferences.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";
import { SpaceMembers } from "./SpaceMembers.tsx";
import { SpaceProfileCard } from "./SpaceProfileCard.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";

interface Props {
  onSaved?: () => void;
}

const VEKTOR_VERSION = import.meta.env.VEKTOR_VERSION;

export function SpaceGeneralSettings(props: Props) {
  const { currentSpace, updateSpace } = useSpace();
  const toast = useToast();

  const [localName, setLocalName] = createSignal("");
  const [localDescription, setLocalDescription] = createSignal("");
  const [localBrandColor, setLocalBrandColor] = createSignal("#1e293b");
  const [localLogoSvg, setLocalLogoSvg] = createSignal("");
  const [localWorkflowCreationEnabled, setLocalWorkflowCreationEnabled] =
    createSignal(true);
  const [isSaving, setIsSaving] = createSignal(false);
  const [isSavingWorkflowCreationEnabled, setIsSavingWorkflowCreationEnabled] =
    createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function saveWorkflowCreationEnabled(enabled: boolean) {
    const space = currentSpace();
    if (!space || isSavingWorkflowCreationEnabled()) return;

    const previousValue = localWorkflowCreationEnabled();
    setLocalWorkflowCreationEnabled(enabled);
    setIsSavingWorkflowCreationEnabled(true);
    setError(null);

    try {
      await api.space.patch(space.id, {
        preferences: {
          [spacePreferenceKeys.workflowCreationEnabled]: String(enabled),
        },
      });
      toast.success("Feature settings saved");
    } catch (err) {
      setLocalWorkflowCreationEnabled(previousValue);
      setError(err instanceof Error ? err.message : "Failed to update feature settings");
    } finally {
      setIsSavingWorkflowCreationEnabled(false);
    }
  }

  async function handleLogoUpload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    const validTypes = ["image/svg+xml", "image/png", "image/jpeg"];
    if (!validTypes.includes(file.type)) {
      setError("Only SVG, PNG, and JPG files are supported");
      return;
    }

    if (file.size > 300 * 1024) {
      setError("Logo file must be smaller than 300 KB");
      return;
    }

    try {
      if (file.type === "image/svg+xml") {
        const svg = sanitizeSvgMarkup(await file.text());
        if (!svg) {
          setError("That file is not an SVG image");
          return;
        }
        setLocalLogoSvg(svg);
      } else {
        const reader = new FileReader();
        reader.onload = (e) => {
          setLocalLogoSvg(e.target?.result as string);
        };
        reader.onerror = () => {
          setError("Failed to read image file");
        };
        reader.readAsDataURL(file);
      }
      setError(null);
    } catch {
      setError("Failed to read image file");
    }
  }

  async function handleSave() {
    const space = currentSpace();
    if (!space) return;

    setIsSaving(true);
    setError(null);

    try {
      await updateSpace(space.id, localName().trim(), space.slug, {
        description: localDescription().trim(),
        brandColor: localBrandColor(),
        logoSvg: localLogoSvg(),
        [spacePreferenceKeys.workflowCreationEnabled]: String(
          localWorkflowCreationEnabled(),
        ),
      });
      toast.success("Space settings saved");
      props.onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update space");
    } finally {
      setIsSaving(false);
    }
  }

  const [showDeleteConfirm, setShowDeleteConfirm] = createSignal(false);
  const [deleteConfirmText, setDeleteConfirmText] = createSignal("");
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  function closeDeleteConfirm() {
    setShowDeleteConfirm(false);
    setDeleteConfirmText("");
    setDeleteError(null);
  }

  async function handleDeleteSpace() {
    const space = currentSpace();
    if (!space?.id || deleteConfirmText() !== space.slug) return;
    setDeleteError(null);
    setIsDeleting(true);

    try {
      await api.space.delete(space.id);
      window.location.href = "/";
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete space");
      setIsDeleting(false);
    }
  }

  createEffect(() => {
    const space = currentSpace();
    if (!space) return;
    if (!isSavingWorkflowCreationEnabled()) {
      setLocalName(space.name);
      setLocalDescription(space.preferences?.description || "");
      setLocalBrandColor(space.preferences?.brandColor || "#1e293b");
      setLocalLogoSvg(space.preferences?.logoSvg || "");
      setLocalWorkflowCreationEnabled(isWorkflowCreationEnabled(space.preferences));
    }
    setError(null);
  });

  return (
    <>
      <div>
        <div class="flex flex-col items-start gap-8 sm:flex-row sm:gap-10">
          <div class="top-4 w-full shrink-0 sm:sticky sm:w-72">
            <SpaceProfileCard
              name={localName()}
              slug={currentSpace()?.slug ?? ""}
              description={localDescription()}
              brandColor={localBrandColor()}
              logo={localLogoSvg()}
              onUpdateBrandColor={setLocalBrandColor}
              onLogoUpload={(event) => void handleLogoUpload(event)}
              onRemoveLogo={() => setLocalLogoSvg("")}
            />
          </div>

          <form
            class="w-full min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div class="space-y-4">
              <div>
                <label
                  for="settings-space-name"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Name
                </label>
                <input
                  id="settings-space-name"
                  value={localName()}
                  onInput={(e) => setLocalName(e.currentTarget.value)}
                  type="text"
                  required
                  class="focus-ring w-full rounded-md border border-neutral-200 px-3 py-1.5 text-size-medium"
                />
              </div>
              <div>
                <label
                  for="settings-space-description"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  Description
                </label>
                <input
                  id="settings-space-description"
                  value={localDescription()}
                  onInput={(e) => setLocalDescription(e.currentTarget.value)}
                  type="text"
                  placeholder="e.g., Engineering / Documentation"
                  class="focus-ring w-full rounded-md border border-neutral-200 px-3 py-1.5 text-size-medium"
                />
              </div>
            </div>
            <Show when={error()}>
              <div class="mt-4 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
                {error()}
              </div>
            </Show>
            <div class="mt-6 flex justify-end">
              <Button
                type="submit"
                disabled={isSaving()}
                text={isSaving() ? "Saving…" : "Save Changes"}
              />
            </div>
          </form>
        </div>

        <section class="mt-10">
          <h2 class="font-semibold text-neutral-900 text-size-large">Features</h2>
          <div class="mt-3 flex items-center justify-between gap-4">
            <div>
              <p class="font-medium text-neutral-900 text-size-medium">Workflows</p>
              <p class="mt-0.5 text-neutral-500 text-size-small">
                Allow members to create workflow documents in this space.
              </p>
            </div>
            <SwitchToggle
              value={localWorkflowCreationEnabled()}
              disabled={isSavingWorkflowCreationEnabled()}
              onInput={(enabled) => void saveWorkflowCreationEnabled(enabled)}
            />
          </div>
        </section>

        <div class="mt-10">
          <SpaceMembers />
        </div>

        <div class="mt-10 pt-6">
          <h2 class="mb-3 font-semibold text-red-700 text-size-medium">Danger Zone</h2>
          <div class="flex items-center justify-between gap-4 rounded-lg border border-primary-200 p-4">
            <div>
              <p class="font-medium text-neutral-900 text-size-medium">
                Delete this space
              </p>
              <p class="mt-0.5 text-neutral-500 text-size-small">
                All documents and data will be archived. This cannot be undone.
              </p>
            </div>
            <Button
              tone="danger"
              text="Delete Space"
              onClick={() => setShowDeleteConfirm(true)}
            />
          </div>
        </div>

        <div class="mt-12 text-right opacity-20">
          <span>Vektor v{VEKTOR_VERSION}</span>
        </div>
      </div>

      <Dialog
        show={showDeleteConfirm()}
        title="Delete Space"
        closeOnBackdrop={!isDeleting()}
        onUpdateShow={(v) => {
          if (!v) closeDeleteConfirm();
        }}
        footer={
          <DialogFooter
            tone="danger"
            confirmLabel="Delete Space"
            pendingLabel="Deleting..."
            pending={isDeleting()}
            disabled={deleteConfirmText() !== currentSpace()?.slug}
            onCancel={closeDeleteConfirm}
            onConfirm={() => void handleDeleteSpace()}
          />
        }
      >
        <p class="mb-3 text-neutral-600 text-size-medium">
          Are you sure you want to delete <strong>{currentSpace()?.name}</strong>? This
          action will archive all documents and data.
        </p>
        <p class="mb-3 text-neutral-600 text-size-medium">
          Type{" "}
          <code class="rounded-sm bg-neutral-100 px-1.5 py-0.5 font-mono text-size-medium">
            {currentSpace()?.slug}
          </code>{" "}
          to confirm:
        </p>
        <input
          value={deleteConfirmText()}
          onInput={(e) => setDeleteConfirmText(e.currentTarget.value)}
          type="text"
          placeholder="Type space slug"
          class="mb-3 w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium focus:outline-none focus:ring-2 focus:ring-red-500"
        />
        <Show when={deleteError()}>
          <div class="mb-3 rounded-sm border border-red-200 bg-red-50 p-2 text-red-600 text-size-medium">
            {deleteError()}
          </div>
        </Show>
      </Dialog>
    </>
  );
}
