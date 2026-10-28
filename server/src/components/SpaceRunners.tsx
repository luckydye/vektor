import { createSignal, For, Show } from "solid-js";
import type { NodeSummary } from "#agent/nodes/protocol.ts";
import type { RunnerSummary } from "#api/client.ts";
import { confirmDialog } from "#composeables/useDialogs.ts";

interface Props {
  /** The user's connected nodes; undefined while loading. */
  nodes: NodeSummary[] | undefined;
  /** The space's HTTP runners; undefined while loading. */
  runners: RunnerSummary[] | undefined;
  /** Resolves with the new runner's secret. */
  onAdd(name: string, url: string): Promise<string>;
  /** Asks the runner what it offers. */
  onDescribe(runnerId: string): Promise<void>;
  onRemove(runnerId: string): Promise<void>;
}

function offers(runner: RunnerSummary): string {
  const { agents } = runner.description;
  return agents.length ? `jobs · agents: ${agents.join(", ")}` : "jobs";
}

const inputClass =
  "focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium";

/**
 * Where the space's jobs and workflows, and agents, can run besides the
 * server: the user's nodes and the space's HTTP runners (docs/runners.md).
 */
export function SpaceRunners(props: Props) {
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

  async function describe(runner: RunnerSummary) {
    setError(null);
    try {
      await props.onDescribe(runner.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check the runner");
    }
  }

  async function remove(runner: RunnerSummary) {
    if (!(await confirmDialog(`Remove the runner "${runner.name}"?`))) return;
    await props.onRemove(runner.id);
  }

  return (
    <div class="space-y-3">
      <Show when={props.nodes?.length || props.runners?.length}>
        <ul class="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-background">
          <For each={props.nodes}>
            {(node) => (
              <li class="flex items-center justify-between gap-4 px-5 py-3">
                <div class="min-w-0">
                  <p class="truncate font-medium text-neutral-900 text-size-medium">
                    {node.name}
                  </p>
                  <p class="truncate text-neutral-500 text-size-small">
                    Node · {node.os} · {node.workdir}
                  </p>
                  <p class="truncate text-neutral-500 text-size-small">
                    {node.shared ? "jobs for the whole space" : "jobs"} · agents:{" "}
                    {node.adapters.join(", ")} · up to {node.maxSessions} sessions
                  </p>
                </div>
              </li>
            )}
          </For>
          <For each={props.runners}>
            {(runner) => (
              <li class="flex items-center justify-between gap-4 px-5 py-3">
                <div class="min-w-0">
                  <p class="truncate font-medium text-neutral-900 text-size-medium">
                    {runner.name}
                  </p>
                  <p class="truncate text-neutral-500 text-size-small">{runner.url}</p>
                  <p class="truncate text-neutral-500 text-size-small">
                    {offers(runner)}
                  </p>
                </div>
                <div class="flex shrink-0 gap-3">
                  <button
                    type="button"
                    onClick={() => void describe(runner)}
                    class="text-blue-600 text-size-small hover:text-blue-800"
                  >
                    Check
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(runner)}
                    class="text-red-600 text-size-small hover:text-red-800"
                  >
                    Remove
                  </button>
                </div>
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
              shown again. Once the runner has it, Check asks what it offers.
            </p>
            <code class="block break-all font-mono">{value()}</code>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <p class="text-red-600 text-size-small">{error()}</p>
      </Show>

      <p class="text-neutral-500 text-size-small">
        A node is a device running <code>vektor agent serve</code>, logged in to this
        space with <code>vektor login</code>. A runner is an HTTP endpoint you add here.
      </p>

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
