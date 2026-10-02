import { createSignal } from "solid-js";
import { Icon } from "./Icon.tsx";
import { MessageInput } from "./MessageInput.tsx";

interface Props {
  spaceId: string;
  placeholder: string;
  disabled: boolean;
  onSubmit: (message: string) => void;
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
    <div class="flex items-start gap-3 rounded-md border border-neutral-100 bg-neutral-10 px-3 py-2">
      <Icon class="mt-0.5 h-5 w-5 shrink-0 text-neutral-500" name="agent-chat" />
      <div class="min-w-0 flex-1">
        <MessageInput
          value={value()}
          onInput={setValue}
          onSubmit={submit}
          placeholder={props.placeholder}
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
  );
}
