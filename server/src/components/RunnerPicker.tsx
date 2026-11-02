import "@atrium-ui/elements/popover";
import { createMemo, Show } from "solid-js";
import { Icon } from "./Icon.tsx";
import { SelectMenu, type SelectMenuItem } from "./SelectMenu.tsx";

const SERVER_LABEL = "Vektor";

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
  let trigger: (HTMLElement & { hide: () => void }) | undefined;
  const items = createMemo<SelectMenuItem[]>(() => [
    { id: "", label: SERVER_LABEL },
    ...props.runners.map((runner) => ({ id: runner, label: runner })),
  ]);

  return (
    <Show
      when={props.onChange}
      fallback={
        <span class="truncate rounded-full border border-neutral-200 bg-neutral-10 px-3 py-1 text-neutral-600 text-size-small" title="Runs on">
          {props.value}
        </span>
      }
    >
      {(onChange) => (
        <a-popover-trigger ref={trigger} showdelay="0" hidedelay="100" class="flex min-w-0">
          <button
            slot="trigger"
            type="button"
            aria-label={props.label}
            title={props.label}
            class="focus-ring flex min-w-0 max-w-[12rem] items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-10 py-1 pr-2 pl-3 text-neutral-600 text-size-small hover:bg-neutral-100"
          >
            <span class="truncate">{props.value ?? SERVER_LABEL}</span>
            <Icon class="h-3.5 w-3.5 shrink-0 text-neutral-400" name="chevron-down" />
          </button>
          <a-popover class="group" placements="top-start">
            <div class="w-max py-1 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
              <div class="origin-bottom-left scale-95 rounded-lg border border-neutral-100 bg-neutral-10 p-5xs shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
                <SelectMenu
                  items={items()}
                  value={props.value ?? ""}
                  onSelect={(item) => {
                    onChange()(item.id || null);
                    trigger?.hide();
                  }}
                />
              </div>
            </div>
          </a-popover>
        </a-popover-trigger>
      )}
    </Show>
  );
}
