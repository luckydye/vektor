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
    <div class="flex items-start gap-3 px-3.5 py-3">
      <Icon class="mt-0.5 h-5 w-5 shrink-0 text-primary-500" name="agent-chat" />
      <div class="min-w-0 flex-1">
        <MessageInput
          value={value()}
          onInput={setValue}
          onSubmit={submit}
          placeholder={props.placeholder}
          rows={2}
          autoGrow
          mentions
          inlineDocumentReferences
          spaceId={props.spaceId}
          disabled={props.disabled}
          actions={
            <button
              type="button"
              onClick={submit}
              disabled={props.disabled}
              class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 transition-colors hover:text-primary-500 disabled:opacity-40"
              title="Send (↵)"
            >
              <Icon class="h-4 w-4" name="send-message" />
            </button>
          }
        />
      </div>
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
