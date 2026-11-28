import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ChatSession } from "#api/client.ts";
import type { BotDraft } from "#composeables/useBotChannels.ts";
import { BotAvatar } from "./AIChatMessages.tsx";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";

interface Props {
  show: boolean;
  onUpdateShow: (value: boolean) => void;
  /** The bot to edit; unset creates one. */
  bot?: ChatSession;
  /** Nodes and runners the viewer may run agents on, with the agents each offers. */
  agentsByRunner: Record<string, string[]>;
  onSave: (draft: BotDraft) => Promise<void>;
}

const inputClass =
  "focus-ring w-full rounded-md border border-neutral-100 px-3 py-2 text-size-medium";
const labelClass = "mb-1 block font-medium text-neutral-900 text-size-small";

/** A run target as one select value: the server, or an agent on a node. */
const SERVER = "";
const targetValue = (node: string | null, agent: string | null) =>
  node ? `${node}\u0000${agent ?? ""}` : SERVER;

/** Creates or edits a bot, laid out like the category dialog. */
export function BotEditorDialog(props: Props) {
  const [title, setTitle] = createSignal("");
  const [avatar, setAvatar] = createSignal("");
  const [rolePrompt, setRolePrompt] = createSignal("");
  const [access, setAccess] = createSignal<"viewer" | "editor">("editor");
  const [target, setTarget] = createSignal(SERVER);
  const [formError, setFormError] = createSignal("");
  const [pending, setPending] = createSignal(false);

  const isNew = () => !props.bot;
  const node = () => (target() === SERVER ? null : target().split("\u0000")[0]);
  const nodeAgent = () => (target() === SERVER ? null : target().split("\u0000")[1]);
  /** Every place the bot could run; an existing bot only shows where it does. */
  const targets = createMemo(() => {
    if (props.bot) {
      return [
        {
          value: targetValue(props.bot.node, props.bot.nodeAgent),
          label: props.bot.node ? `${props.bot.nodeAgent} on ${props.bot.node}` : "Vektor",
        },
      ];
    }
    return [
      { value: SERVER, label: "Vektor" },
      ...Object.entries(props.agentsByRunner).flatMap(([runner, agents]) =>
        agents.map((agent) => ({
          value: targetValue(runner, agent),
          label: `${agent} on ${runner}`,
        })),
      ),
    ];
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
        setTarget(targetValue(bot?.node ?? null, bot?.nodeAgent ?? null));
        setFormError("");
      },
    ),
  );

  function chooseTarget(value: string) {
    setTarget(value);
    // Whoever may post runs commands on the node.
    if (value !== SERVER) setAccess("editor");
  }

  async function handleSubmit(event: Event) {
    event.preventDefault();
    if (pending()) return;
    if (!title().trim()) return setFormError("Give the bot a name");
    setPending(true);
    setFormError("");
    try {
      await props.onSave({
        title: title().trim(),
        avatar: avatar().trim(),
        rolePrompt: rolePrompt().trim(),
        access: access(),
        node: node(),
        nodeAgent: nodeAgent(),
      });
      props.onUpdateShow(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Failed to save the bot");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      title={isNew() ? "New bot" : "Edit bot"}
      closeOnBackdrop={!pending()}
      onUpdateShow={(value) => {
        if (!value) props.onUpdateShow(false);
      }}
      footer={
        <DialogFooter
          form="bot-editor-form"
          confirmLabel={isNew() ? "Create" : "Update"}
          pendingLabel="Saving..."
          pending={pending()}
          onCancel={() => props.onUpdateShow(false)}
        />
      }
    >
      <form id="bot-editor-form" onSubmit={handleSubmit} class="space-y-4">
        {/* The bot as its sidebar row will show it. */}
        <div class="space-y-2">
          <div class="rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-2">
            <div class="flex items-center gap-2 text-neutral-900 text-size-normal">
              <BotAvatar avatar={avatar() || null} class="h-6 w-6 rounded-full text-size-small" />
              <span class="truncate font-medium">{title() || "Untitled bot"}</span>
            </div>
          </div>
          <label class="flex items-center gap-1.5 text-neutral-500 text-size-small">
            Icon
            <input
              title="Icon (emoji or text)"
              value={avatar()}
              onInput={(event) => setAvatar(event.currentTarget.value)}
              type="text"
              maxlength="8"
              placeholder="🤖"
              class="focus-ring h-7 w-10 flex-none rounded-md border border-neutral-100 text-center text-size-medium"
            />
          </label>
        </div>

        <div>
          <label for="bot-name" class={labelClass}>
            Name
          </label>
          <input
            id="bot-name"
            type="text"
            required
            value={title()}
            placeholder="Bot name"
            class={inputClass}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />
        </div>

        <div>
          <label for="bot-role" class={labelClass}>
            Role
          </label>
          <textarea
            id="bot-role"
            rows={4}
            value={rolePrompt()}
            placeholder="What the bot does and how it answers"
            class={`${inputClass} resize-y`}
            onInput={(event) => setRolePrompt(event.currentTarget.value)}
          />
          <p class="mt-1 text-neutral-500 text-size-extra-small">
            Leave empty for a general assistant.
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="bot-target" class={labelClass}>
              Runs on
            </label>
            <select
              id="bot-target"
              class={inputClass}
              value={target()}
              disabled={!isNew()}
              onChange={(event) => chooseTarget(event.currentTarget.value)}
            >
              <For each={targets()}>
                {(option) => <option value={option.value}>{option.label}</option>}
              </For>
            </select>
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
              <option value="editor">Editors</option>
              <option value="viewer">Everyone</option>
            </select>
          </div>
        </div>
        <p class="-mt-2 text-neutral-500 text-size-extra-small">
          <Show
            when={node()}
            fallback={
              access() === "editor"
                ? "The bot can read and change the space, like an editor."
                : "The bot can only read the space, like a viewer."
            }
          >
            Every editor runs commands on {node()} through this bot. Where a bot runs is
            fixed once it exists.
          </Show>
        </p>

        <Show when={formError()}>
          <div class="rounded-md border border-red-200 bg-red-50 p-3">
            <p class="text-red-600 text-size-small">{formError()}</p>
          </div>
        </Show>
      </form>
    </Dialog>
  );
}
