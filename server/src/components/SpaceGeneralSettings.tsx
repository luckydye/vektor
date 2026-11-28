import { createEffect, createSignal, Show } from "solid-js";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  isRepositoryCreationEnabled,
  isWorkflowCreationEnabled,
  spacePreferenceKeys,
} from "#utils/spacePreferences.ts";
import { Button } from "./Button.tsx";
import { DeleteSpaceDialog } from "./DeleteSpaceDialog.tsx";
import { SettingsSection } from "./SettingsSection.tsx";
import { SpaceMembers } from "./SpaceMembers.tsx";
import { SpaceAppearance } from "./SpaceAppearance.tsx";
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
        <SettingsSection
          id="general-profile"
          title="Space Settings"
          description="Personalize your space with settings and preferences."
        >
          <form
            class="max-w-xl"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div class="space-y-4">
              <div>
                <label for="settings-space-name" class="form-label">
                  Name
                </label>
                <div class="flex gap-2">
                  <SpaceAppearance
                    name={localName()}
                    brandColor={localBrandColor()}
                    logo={localLogoSvg()}
                    onUpdateBrandColor={setLocalBrandColor}
                    onUpdateLogo={setLocalLogoSvg}
                  />
                  <input
                    id="settings-space-name"
                    value={localName()}
                    onInput={(e) => setLocalName(e.currentTarget.value)}
                    type="text"
                    required
                    class="form-control"
                  />
                </div>
              </div>
              <div>
                <label for="settings-space-description" class="form-label">
                  Description
                </label>
                <input
                  id="settings-space-description"
                  value={localDescription()}
                  onInput={(e) => setLocalDescription(e.currentTarget.value)}
                  type="text"
                  placeholder="e.g., Engineering / Documentation"
                  class="form-control"
                />
              </div>
            </div>
            <Show when={error()}>
              <p class="mt-4 form-error">{error()}</p>
            </Show>
            <div class="mt-6 flex justify-end">
              <Button
                type="submit"
                disabled={isSaving()}
                text={isSaving() ? "Saving…" : "Save Changes"}
              />
            </div>
          </form>
        </SettingsSection>

        <SettingsSection
          id="features"
          title="Features"
          description="Choose which document types members can create."
        >
          <div class="flex items-center justify-between gap-4">
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
        </SettingsSection>

        <SettingsSection
          id="access"
          title="Access"
          description="Members, groups and tokens with access to this space."
        >
          <SpaceMembers />
        </SettingsSection>

        <SettingsSection
          id="share-links"
          title="Share links"
          description="Review every read-only link created for pages in this space."
        >
          <SpaceShareLinks />
        </SettingsSection>

        <SettingsSection id="danger-zone" title="Danger Zone">
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
        </SettingsSection>

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
