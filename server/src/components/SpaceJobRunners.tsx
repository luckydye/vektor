import { createSignal, For, Show } from "solid-js";
import type { JobRunnerSummary } from "#api/client.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";

interface Props {
  /** Undefined while loading. */
  runners: JobRunnerSummary[] | undefined;
  /** Resolves with the new runner's secret. */
  onAdd(name: string, url: string): Promise<string>;
  onRemove(runnerId: string): Promise<void>;
}

const inputClass =
  "focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium";

/** HTTP endpoints that run the space's jobs and workflows (docs/job-runners.md). */
export function SpaceJobRunners(props: Props) {
  const [name, setName] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [secret, setSecret] = createSignal<string | null>(null);

  async function add() {
    setError(null);
    try {
      setSecret(await props.onAdd(name().trim(), url().trim()));
      setName("");
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add the runner");
    }
  }

  async function remove(runner: JobRunnerSummary) {
    if (!(await confirmDialog(`Remove the runner "${runner.name}"?`))) return;
    await props.onRemove(runner.id);
  }

  return (
    <div class="space-y-3">
      <Show when={props.runners?.length}>
        <ul class="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-background">
          <For each={props.runners}>
            {(runner) => (
              <li class="flex items-center justify-between gap-4 px-5 py-3">
                <div class="min-w-0">
                  <p class="truncate font-medium text-neutral-900 text-size-medium">
                    {runner.name}
                  </p>
                  <p class="truncate text-neutral-500 text-size-small">{runner.url}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(runner)}
                  class="text-red-600 text-size-small hover:text-red-800"
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={secret()}>
        {(value) => (
          <div class="rounded-md border border-blue-200 bg-blue-50 p-3 text-size-small">
            <p class="mb-1 text-neutral-700">
              The runner's secret, sent as <code>Authorization: Bearer …</code>. It is not
              shown again.
            </p>
            <code class="block break-all font-mono">{value()}</code>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <p class="text-red-600 text-size-small">{error()}</p>
      </Show>

      <form
        class="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <input
          aria-label="Runner name"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          required
          placeholder="Name"
          class={`${inputClass} max-w-[12rem]`}
        />
        <input
          aria-label="Runner URL"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          required
          type="url"
          placeholder="https://runner.example.com/job"
          class={`${inputClass} min-w-[16rem] flex-1`}
        />
        <button
          type="submit"
          class="font-medium text-blue-600 text-size-small hover:text-blue-800"
        >
          + Add runner
        </button>
      </form>
    </div>
  );
}
