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
          label: props.bot.node
            ? `${props.bot.nodeAgent} on ${props.bot.node}`
            : "Vektor",
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
      <form id="bot-editor-form" onSubmit={handleSubmit} class="space-y-5">
        <div>
          <label for="bot-name" class="form-label">
            Name
          </label>
          <div class="flex gap-2">
            {/* The icon, shown as the bot's avatar until one is typed. */}
            <label class="relative flex-none" title="Icon (emoji or text)">
              <Show when={!avatar()}>
                <BotAvatar
                  avatar={null}
                  class="pointer-events-none absolute inset-1.5 rounded-md"
                />
              </Show>
              <input
                aria-label="Icon"
                value={avatar()}
                onInput={(event) => setAvatar(event.currentTarget.value)}
                type="text"
                maxlength="8"
                class="form-control h-full w-11 px-0 text-center"
              />
            </label>
            <input
              id="bot-name"
              type="text"
              required
              value={title()}
              placeholder="Bot name"
              class="form-control"
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </div>
        </div>

        <div>
          <label for="bot-role" class="form-label">
            Role
          </label>
          <textarea
            id="bot-role"
            rows={4}
            value={rolePrompt()}
            placeholder="What the bot does and how it answers"
            class="form-control resize-y"
            onInput={(event) => setRolePrompt(event.currentTarget.value)}
          />
          <p class="form-hint">Leave empty for a general assistant.</p>
        </div>

        <div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label for="bot-target" class="form-label">
                Runs on
              </label>
              <select
                id="bot-target"
                class="form-control"
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
              <label for="bot-access" class="form-label">
                Who can post
              </label>
              <select
                id="bot-access"
                class="form-control"
                value={access()}
                disabled={!!node()}
                onChange={(event) =>
                  setAccess(event.currentTarget.value as "viewer" | "editor")
                }
              >
                <option value="editor">Editors</option>
                <option value="viewer">Everyone</option>
              </select>
            </div>
          </div>
          <p class="form-hint">
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
        </div>

        <Show when={formError()}>
          <p class="form-error">{formError()}</p>
        </Show>
      </form>
    </Dialog>
  );
}
