import { For, Show } from "solid-js";

interface Props {
  /** Runners and nodes to offer besides the server, by name. */
  runners: string[];
  /** The chosen one; null is the server. */
  value: string | null;
  /** Unset shows the choice without letting it change, as for a running chat. */
  onChange?: (runner: string | null) => void;
  /** What runs there, as in "Run the agent on". */
  label: string;
}

/** Where a chat's agent or a workflow runs: on the server, or on a runner or node. */
export function RunnerPicker(props: Props) {
  return (
    <Show
      when={props.onChange}
      fallback={
        <span class="truncate px-1.5 text-neutral-500 text-size-small" title="Runs on">
          {props.value}
        </span>
      }
    >
      {(onChange) => (
        <select
          aria-label={props.label}
          title={props.label}
          value={props.value ?? ""}
          onChange={(event) => onChange()(event.currentTarget.value || null)}
          class="focus-ring min-w-0 max-w-[10rem] truncate rounded-md bg-transparent px-1.5 py-1 text-neutral-600 text-size-small hover:bg-neutral-100"
        >
          <option value="">Vektor</option>
          <For each={props.runners}>
            {(runner) => <option value={runner}>{runner}</option>}
          </For>
        </select>
      )}
    </Show>
  );
}
