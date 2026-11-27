import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ChatSession } from "#api/client.ts";
import type { BotDraft } from "#composeables/useBotChannels.ts";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";
import { RunnerPicker } from "./RunnerPicker.tsx";

interface Props {
  show: boolean;
  onUpdateShow: (value: boolean) => void;
  /** The bot to edit; unset creates one. */
  bot?: ChatSession;
  /** Nodes and runners the viewer may run agents on, with the agents each offers. */
  agentsByRunner: Record<string, string[]>;
  onSave: (draft: BotDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
}

const inputClass =
  "focus-ring w-full rounded-md border border-neutral-100 bg-neutral-10 px-3 py-2 text-size-medium";
const labelClass = "mb-1 block font-medium text-neutral-900 text-size-small";

/** Creates or edits a bot: its name, avatar, role, where it runs and who may post. */
export function BotEditorDialog(props: Props) {
  const [title, setTitle] = createSignal("");
  const [avatar, setAvatar] = createSignal("");
  const [rolePrompt, setRolePrompt] = createSignal("");
  const [access, setAccess] = createSignal<"viewer" | "editor">("editor");
  const [node, setNode] = createSignal<string | null>(null);
  const [nodeAgent, setNodeAgent] = createSignal<string | null>(null);
  const [formError, setFormError] = createSignal("");
  const [pending, setPending] = createSignal(false);

  const isNew = () => !props.bot;
  const nodeAgents = createMemo(() => {
    const chosen = node();
    return chosen ? (props.agentsByRunner[chosen] ?? []) : [];
  });

  createEffect(
    on(
      () => props.show,
      (show) => {
        if (!show) return;
        const bot = props.bot;
        setTitle(bot?.title ?? "");
        setAvatar(bot?.avatar ?? "");
        setRolePrompt(bot?.rolePrompt ?? "");
        setAccess(bot?.access ?? "editor");
        setNode(bot?.node ?? null);
        setNodeAgent(bot?.nodeAgent ?? null);
        setFormError("");
      },
    ),
  );

  function chooseNode(runner: string | null) {
    setNode(runner);
    setNodeAgent(runner ? (props.agentsByRunner[runner]?.[0] ?? null) : null);
    if (runner) setAccess("editor");
  }

  async function run(action: () => Promise<void>) {
    if (pending()) return;
    setPending(true);
    setFormError("");
    try {
      await action();
      props.onUpdateShow(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save the bot");
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: Event) {
    event.preventDefault();
    if (!title().trim()) return setFormError("Give the bot a name");
    if (node() && !nodeAgent()) return setFormError("Pick the agent it runs on the node");
    void run(() =>
      props.onSave({
        title: title().trim(),
        avatar: avatar().trim(),
        rolePrompt: rolePrompt().trim(),
        access: access(),
        node: node(),
        nodeAgent: nodeAgent(),
      }),
    );
  }

  return (
    <Dialog
      show={props.show}
      title={isNew() ? "New bot" : "Edit bot"}
      onUpdateShow={(value) => {
        if (!value) props.onUpdateShow(false);
      }}
      footer={
        <DialogFooter
          form="bot-editor-form"
          confirmLabel={isNew() ? "Create" : "Save"}
          pendingLabel={isNew() ? "Creating…" : "Saving…"}
          pending={pending()}
          onCancel={() => props.onUpdateShow(false)}
        />
      }
    >
      <form id="bot-editor-form" onSubmit={handleSubmit} class="space-y-4">
        <div class="flex gap-3">
          <div class="w-20">
            <label for="bot-avatar" class={labelClass}>
              Avatar
            </label>
            <input
              id="bot-avatar"
              type="text"
              maxLength={8}
              value={avatar()}
              placeholder="🤖"
              class={`${inputClass} text-center`}
              onInput={(event) => setAvatar(event.currentTarget.value)}
            />
          </div>
          <div class="flex-1">
            <label for="bot-name" class={labelClass}>
              Name
            </label>
            <input
              id="bot-name"
              type="text"
              required
              value={title()}
              placeholder="Release helper"
              class={inputClass}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </div>
        </div>

        <div>
          <label for="bot-role" class={labelClass}>
            Role
          </label>
          <textarea
            id="bot-role"
            rows={5}
            value={rolePrompt()}
            placeholder="What the bot does and how it answers. Leave empty for a general assistant."
            class={inputClass}
            onInput={(event) => setRolePrompt(event.currentTarget.value)}
          />
        </div>

        <div>
          <span class={labelClass}>Runs on</span>
          <div class="flex flex-wrap items-center gap-2">
            <RunnerPicker
              runners={Object.keys(props.agentsByRunner)}
              value={node()}
              onChange={isNew() ? chooseNode : undefined}
              label="Run the bot on"
            />
            <Show when={node() && isNew()}>
              <select
                aria-label="Agent"
                class="focus-ring rounded-full border border-neutral-200 bg-neutral-10 px-3 py-1 text-neutral-600 text-size-small"
                value={nodeAgent() ?? ""}
                onChange={(event) => setNodeAgent(event.currentTarget.value || null)}
              >
                <For each={nodeAgents()}>{(agent) => <option value={agent}>{agent}</option>}</For>
              </select>
            </Show>
            <Show when={node() && !isNew()}>
              <span class="text-neutral-500 text-size-small">{nodeAgent()}</span>
            </Show>
          </div>
          <Show when={node()}>
            <p class="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-amber-800 text-size-small">
              Every editor of this space will run commands on {node()} through this bot.
            </p>
          </Show>
        </div>

        <div>
          <label for="bot-access" class={labelClass}>
            Who can post
          </label>
          <select
            id="bot-access"
            class={inputClass}
            value={access()}
            disabled={!!node()}
            onChange={(event) => setAccess(event.currentTarget.value as "viewer" | "editor")}
          >
            <option value="editor">Editors — the bot can read and change the space</option>
            <option value="viewer">Everyone — the bot can only read the space</option>
          </select>
        </div>

        <Show when={formError()}>
          <p class="text-red-600 text-size-small">{formError()}</p>
        </Show>

        <Show when={props.onDelete}>
          {(onDelete) => (
            <div class="border-neutral-100 border-t pt-3">
              <button
                type="button"
                class="text-red-600 text-size-small hover:underline"
                disabled={pending()}
                onClick={() => void run(onDelete())}
              >
                Delete bot and all its messages
              </button>
            </div>
          )}
        </Show>
      </form>
    </Dialog>
  );
}
