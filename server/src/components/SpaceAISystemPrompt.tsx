import { createEffect, createMemo, createSignal } from "solid-js";
import { api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import {
  MAX_AI_SYSTEM_PROMPT_LENGTH,
  spacePreferenceKeys,
} from "#utils/spacePreferences.ts";
import { Button } from "./Button.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/**
 * Instructions the space adds to every agent session's system prompt. The
 * agent reads them again on each turn, so an edit applies to open sessions.
 */
export function SpaceAISystemPrompt() {
  const { currentSpace } = useSpace();
  const toast = useToast();

  const [prompt, setPrompt] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const storedPrompt = createMemo(
    () => currentSpace()?.preferences?.[spacePreferenceKeys.aiSystemPrompt] ?? "",
  );

  // Only when the space changes, so a background space update does not discard
  // what the owner is writing.
  let loadedSpaceId: string | null = null;
  createEffect(() => {
    const space = currentSpace();
    if (!space || loadedSpaceId === space.id) return;
    loadedSpaceId = space.id;
    setPrompt(storedPrompt());
    setError(null);
  });

  async function save(event: Event) {
    event.preventDefault();
    const space = currentSpace();
    if (!space) return;
    setSaving(true);
    setError(null);
    try {
      await api.space.patch(space.id, {
        preferences: { [spacePreferenceKeys.aiSystemPrompt]: prompt().trim() },
      });
      toast.success("System prompt saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the system prompt");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      id="ai-system-prompt"
      title="System prompt"
      description="Extra instructions added to the system prompt of every agent session in this space."
    >
      <form onSubmit={(event) => void save(event)}>
        <div class="overflow-hidden rounded-xl border border-neutral-200 bg-background">
          <div class="p-5 sm:p-6">
            <label
              for="ai-system-prompt-text"
              class="block font-medium text-neutral-900 text-size-medium"
            >
              Instructions for the agent
            </label>
            <p class="mt-0.5 text-neutral-500 text-size-small">
              Use it for how this space works, who the agent is, or rules it should
              always follow.
            </p>
            <textarea
              id="ai-system-prompt-text"
              rows="7"
              maxLength={MAX_AI_SYSTEM_PROMPT_LENGTH}
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
              placeholder="e.g. Always answer in French. Cite the document you used. Never change a document's sharing settings."
              class="focus-ring mt-4 w-full resize-y rounded-md border border-neutral-200 bg-background px-3 py-2 font-mono text-size-medium leading-relaxed"
            />
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 border-neutral-200 border-t bg-neutral-50 px-5 py-3 sm:px-6">
            <p class="text-neutral-500 text-size-small">
              {prompt().length.toLocaleString()} /{" "}
              {MAX_AI_SYSTEM_PROMPT_LENGTH.toLocaleString()} characters
            </p>
            <Button
              type="submit"
              disabled={saving() || prompt().trim() === storedPrompt().trim()}
              text={saving() ? "Saving…" : "Save prompt"}
            />
          </div>
        </div>
      </form>
      {error() ? <p class="mt-2 text-red-600 text-size-small">{error()}</p> : null}
    </SettingsSection>
  );
}
