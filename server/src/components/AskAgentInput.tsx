import { createSignal, Show } from "solid-js";
import { Icon } from "./Icon.tsx";
import { MessageInput } from "./MessageInput.tsx";
import { RunnerPicker } from "./RunnerPicker.tsx";

interface Props {
  spaceId: string;
  placeholder: string;
  disabled: boolean;
  onSubmit: (message: string) => void;
  /** Shared `view-transition-name`, so the box can morph into another element. */
  transitionName?: string;
  /** Nodes and runners to offer besides the server; none hides the picker. */
  runners?: string[];
  /** The chosen node; null is the server. */
  node?: string | null;
  onNodeChange?: (node: string | null) => void;
}

export function AskAgentInput(props: Props) {
  const [value, setValue] = createSignal("");

  function submit() {
    const message = value().trim();
    if (!message || props.disabled) return;
    props.onSubmit(message);
    setValue("");
  }

  return (
    <div style={{ "view-transition-name": props.transitionName }}>
      <div class="px-3 pt-2.5 pb-2">
        <MessageInput
          value={value()}
          onInput={setValue}
          onSubmit={submit}
          placeholder={props.placeholder}
          rows={3}
          autoGrow
          mentions
          inlineDocumentReferences
          spaceId={props.spaceId}
          disabled={props.disabled}
          actions={
            <button
              type="button"
              onClick={submit}
              disabled={props.disabled || !value().trim()}
              class="flex h-7 pointer-coarse:h-9 pointer-coarse:w-9 w-7 shrink-0 items-center justify-center rounded-lg bg-primary-600 text-white transition-colors enabled:hover:bg-primary-700 disabled:bg-neutral-100 disabled:text-neutral-400"
              title="Send (↵)"
            >
              <Icon class="h-3.5 w-3.5" name="send-message" />
            </button>
          }
        />
      </div>
      <Show when={props.runners?.length}>
        <div class="flex items-center gap-2 border-neutral-100 border-t bg-neutral-50 px-3 py-2">
          <RunnerPicker
            runners={props.runners ?? []}
            value={props.node ?? null}
            onChange={props.onNodeChange}
            label="Run the agent on"
          />
        </div>
      </Show>
    </div>
  );
}
