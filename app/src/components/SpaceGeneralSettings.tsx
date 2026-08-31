import { createEffect, createSignal, Show } from "solid-js";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { imageFileAsDataUrl } from "#utils/image.ts";
import {
  isRepositoryCreationEnabled,
  isWorkflowCreationEnabled,
  spacePreferenceKeys,
} from "#utils/spacePreferences.ts";
import { Button } from "./Button.tsx";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog.tsx";
import { SpaceMembers } from "./SpaceMembers.tsx";
import { SpaceProfileCard } from "./SpaceProfileCard.tsx";
import { SpaceShareLinks } from "./SpaceShareLinks.tsx";
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
    createSignal(false);
  const [localRepositoryCreationEnabled, setLocalRepositoryCreationEnabled] =
    createSignal(false);
  const [isSaving, setIsSaving] = createSignal(false);
  /** The preference key being written, so its own toggle is the one disabled. */
  const [savingFeature, setSavingFeature] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** A feature toggle saves on its own, rather than waiting for Save Changes. */
  async function saveFeature(
    key: string,
    enabled: boolean,
    localValue: () => boolean,
    setLocalValue: (value: boolean) => void,
  ) {
    const space = currentSpace();
    if (!space || savingFeature()) return;

    const previousValue = localValue();
    setLocalValue(enabled);
    setSavingFeature(key);
    setError(null);

    try {
      await api.space.patch(space.id, { preferences: { [key]: String(enabled) } });
      toast.success("Feature settings saved");
    } catch (err) {
      setLocalValue(previousValue);
      setError(err instanceof Error ? err.message : "Failed to update feature settings");
    } finally {
      setSavingFeature(null);
    }
  }

  async function handleLogoUpload(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    try {
      setLocalLogoSvg(await imageFileAsDataUrl(file));
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to read image file");
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
        [spacePreferenceKeys.repositoryCreationEnabled]: String(
          localRepositoryCreationEnabled(),
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

  createEffect(() => {
    const space = currentSpace();
    if (!space) return;
    if (!savingFeature()) {
      setLocalName(space.name);
      setLocalDescription(space.preferences?.description || "");
      setLocalBrandColor(space.preferences?.brandColor || "#1e293b");
      setLocalLogoSvg(space.preferences?.logoSvg || "");
      setLocalWorkflowCreationEnabled(isWorkflowCreationEnabled(space.preferences));
      setLocalRepositoryCreationEnabled(isRepositoryCreationEnabled(space.preferences));
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
              disabled={savingFeature() === spacePreferenceKeys.workflowCreationEnabled}
              onInput={(enabled) =>
                void saveFeature(
                  spacePreferenceKeys.workflowCreationEnabled,
                  enabled,
                  localWorkflowCreationEnabled,
                  setLocalWorkflowCreationEnabled,
                )
              }
            />
          </div>
          <div class="mt-4 flex items-center justify-between gap-4">
            <div>
              <p class="font-medium text-neutral-900 text-size-medium">Repositories</p>
              <p class="mt-0.5 text-neutral-500 text-size-small">
                Allow members to create repository documents in this space.
              </p>
            </div>
            <SwitchToggle
              value={localRepositoryCreationEnabled()}
              disabled={savingFeature() === spacePreferenceKeys.repositoryCreationEnabled}
              onInput={(enabled) =>
                void saveFeature(
                  spacePreferenceKeys.repositoryCreationEnabled,
                  enabled,
                  localRepositoryCreationEnabled,
                  setLocalRepositoryCreationEnabled,
                )
              }
            />
          </div>
        </section>

        <div class="mt-10">
          <SpaceMembers />
        </div>

        <div class="mt-10">
          <SpaceShareLinks />
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

      <DeleteSpaceDialog
        space={showDeleteConfirm() ? currentSpace() : null}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={async (spaceId) => {
          // Rejections stay in the dialog; a space that is gone has nothing
          // left to show, so the redirect only happens on success.
          await api.space.delete(spaceId);
          window.location.href = "/";
        }}
      />
    </>
  );
}
