import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Permission } from "#acl/permissions.ts";
import { type AIUsage, api } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { Button } from "./Button.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

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

/** The space's estimated AI token usage this week, and its weekly budget; for owners. */
export function SpaceAIUsage() {
  const { currentSpace } = useSpace();
  const toast = useToast();

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

  return (
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
                <p class="font-medium text-neutral-500 text-size-small">This week</p>
                <div class="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span class="font-semibold text-neutral-900 text-size-display">
                    <Pending value={aiUsageDisplay()?.used} class="w-8" />
                  </span>
                  <span class="text-neutral-500 text-size-medium">
                    / <Pending value={aiUsageDisplay()?.limit} class="w-20" /> estimated
                    tokens
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
                Set up to <Pending value={aiUsageDisplay()?.maxLimit} class="w-20" />{" "}
                tokens per week for this space.
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
  );
}
