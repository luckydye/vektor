import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Permission } from "#acl/permissions.ts";
import { type AIUsage, api } from "#api/client.ts";
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
import { SettingsSection } from "./SettingsSection.tsx";
import { SpaceMembers } from "./SpaceMembers.tsx";
import { SpaceProfileCard } from "./SpaceProfileCard.tsx";
import { SpaceShareLinks } from "./SpaceShareLinks.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";

interface Props {
  onSaved?: () => void;
}

const VEKTOR_VERSION = import.meta.env.VEKTOR_VERSION;

function formatAIUsage(usage: AIUsage) {
  const percent = Math.round((usage.used / usage.limit) * 100);
  return {
    used: usage.used.toLocaleString(),
    limit: usage.limit.toLocaleString(),
    maxLimit: usage.maxLimit.toLocaleString(),
    remaining: Math.max(0, usage.limit - usage.used).toLocaleString(),
    percentLabel: `${percent}% used`,
    progressWidth: `${Math.min(100, (usage.used / usage.limit) * 100)}%`,
  };
}

/** A loading-sized stand-in, so the card keeps its layout until the value arrives. */
function Pending(props: { value: string | undefined; class: string }) {
  return (
    <Show
      when={props.value}
      fallback={
        <span
          class={`inline-block h-[0.8em] animate-pulse rounded bg-skeleton ${props.class}`}
        />
      }
    >
      {props.value}
    </Show>
  );
}

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
  const [aiUsage, setAIUsage] = createSignal<AIUsage | null>(null);
  const [weeklyLimit, setWeeklyLimit] = createSignal("");
  const [savingAILimit, setSavingAILimit] = createSignal(false);
  const [aiLimitError, setAILimitError] = createSignal<string | null>(null);
  const aiUsageDisplay = createMemo(() => {
    const usage = aiUsage();
    return usage ? formatAIUsage(usage) : null;
  });

  // Keyed on id and role so a space update, which swaps the object, does not refetch.
  const ownedSpaceId = createMemo(() => {
    const space = currentSpace();
    return space?.userRole === Permission.OWNER ? space.id : null;
  });

  createEffect(() => {
    const spaceId = ownedSpaceId();
    setAIUsage(null);
    setAILimitError(null);
    if (!spaceId) return;
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });
    void api.aiLimit
      .get(spaceId)
      .then((usage) => {
        if (cancelled) return;
        setAIUsage(usage);
        setWeeklyLimit(String(usage.limit));
      })
      .catch((err) => {
        if (!cancelled) {
          setAILimitError(err instanceof Error ? err.message : "Failed to load AI usage");
        }
      });
  });

  async function saveAILimit(event: Event) {
    event.preventDefault();
    const space = currentSpace();
    if (!space) return;
    const limit = Number(weeklyLimit());
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > (aiUsage()?.maxLimit ?? 0)) {
      setAILimitError(
        `Enter a limit between 1 and ${aiUsage()?.maxLimit.toLocaleString() ?? "the instance maximum"}.`,
      );
      return;
    }
    setSavingAILimit(true);
    setAILimitError(null);
    try {
      const usage = await api.aiLimit.put(space.id, limit);
      if (currentSpace()?.id === space.id) {
        setAIUsage(usage);
        setWeeklyLimit(String(usage.limit));
      }
      toast.success("Weekly AI limit saved");
    } catch (err) {
      setAILimitError(err instanceof Error ? err.message : "Failed to save AI limit");
    } finally {
      setSavingAILimit(false);
    }
  }

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
        <SettingsSection
          title="Space Settings"
          description="Personalize your space with settings and preferences."
        >
          <div class="flex flex-col items-start gap-8 sm:flex-row sm:gap-10">
            <div class="w-full shrink-0 sm:w-72">
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
        </SettingsSection>

        <SettingsSection
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

        <Show when={currentSpace()?.userRole === Permission.OWNER}>
          <SettingsSection
            title="AI usage"
            description="Track this space's estimated AI token usage and set its weekly budget."
          >
            <Show
              when={aiUsageDisplay() || !aiLimitError()}
              fallback={
                <div class="rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-neutral-500 text-size-small">
                  Usage is unavailable.
                </div>
              }
            >
              <div class="overflow-hidden rounded-xl border border-neutral-200 bg-background">
                <div class="p-5 sm:p-6">
                  <div class="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p class="font-medium text-neutral-500 text-size-small">
                        This week
                      </p>
                      <div class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span class="font-semibold text-neutral-900 text-size-display">
                          <Pending value={aiUsageDisplay()?.used} class="w-8" />
                        </span>
                        <span class="text-neutral-500 text-size-medium">
                          / <Pending value={aiUsageDisplay()?.limit} class="w-20" />{" "}
                          estimated tokens
                        </span>
                      </div>
                    </div>
                    <span class="rounded-full bg-primary-50 px-3 py-1 font-medium text-primary-700 text-size-small">
                      <Pending value={aiUsageDisplay()?.percentLabel} class="w-14" />
                    </span>
                  </div>

                  <div
                    class="mt-5 h-2 w-full overflow-hidden rounded-full bg-neutral-100"
                    role="progressbar"
                    aria-label="Weekly AI token usage"
                    aria-valuemin="0"
                    aria-valuemax={aiUsage()?.limit ?? 0}
                    aria-valuenow={Math.min(aiUsage()?.used ?? 0, aiUsage()?.limit ?? 0)}
                    aria-valuetext={
                      aiUsageDisplay()
                        ? `${aiUsageDisplay()?.used} of ${aiUsageDisplay()?.limit} tokens used`
                        : undefined
                    }
                  >
                    <div
                      class="h-full rounded-full bg-primary-500 transition-[width] duration-300"
                      style={{ width: aiUsageDisplay()?.progressWidth ?? "0%" }}
                    />
                  </div>
                  <div class="mt-2 flex flex-wrap justify-between gap-x-4 text-neutral-500 text-size-small">
                    <span>
                      <Pending value={aiUsageDisplay()?.remaining} class="w-20" /> tokens
                      remaining
                    </span>
                    <span>Resets Monday at 00:00 UTC</span>
                  </div>
                </div>

                <form
                  class="flex flex-wrap items-end justify-between gap-4 border-neutral-200 border-t bg-neutral-50 px-5 py-4 sm:px-6"
                  onSubmit={(event) => void saveAILimit(event)}
                >
                  <div class="min-w-0 flex-1">
                    <label
                      for="ai-weekly-limit"
                      class="block font-medium text-neutral-900 text-size-medium"
                    >
                      Weekly token limit
                    </label>
                    <p class="mt-0.5 text-neutral-500 text-size-small">
                      Set up to{" "}
                      <Pending value={aiUsageDisplay()?.maxLimit} class="w-20" /> tokens
                      per week for this space.
                    </p>
                  </div>
                  <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <input
                      id="ai-weekly-limit"
                      type="number"
                      min="1"
                      max={aiUsage()?.maxLimit}
                      required
                      disabled={!aiUsageDisplay()}
                      value={weeklyLimit()}
                      onInput={(event) => setWeeklyLimit(event.currentTarget.value)}
                      class="focus-ring min-w-0 flex-1 rounded-md border border-neutral-200 bg-background px-3 py-1.5 text-size-medium sm:w-40 sm:flex-none"
                    />
                    <Button
                      type="submit"
                      disabled={
                        !aiUsage() ||
                        savingAILimit() ||
                        weeklyLimit() === String(aiUsage()?.limit)
                      }
                      text={savingAILimit() ? "Saving…" : "Save limit"}
                    />
                  </div>
                </form>
              </div>
            </Show>
            <Show when={aiLimitError()}>
              <p class="mt-2 text-red-600 text-size-small">{aiLimitError()}</p>
            </Show>
          </SettingsSection>
        </Show>

        <SettingsSection
          title="Access"
          description="Members, groups and tokens with access to this space."
        >
          <SpaceMembers />
        </SettingsSection>

        <SettingsSection
          title="Share links"
          description="Review every read-only link created for pages in this space."
        >
          <SpaceShareLinks />
        </SettingsSection>

        <SettingsSection title="Danger Zone">
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
