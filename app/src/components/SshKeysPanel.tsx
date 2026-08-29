import { createSignal, For, Show } from "solid-js";
import type { UserSshKey } from "#api/client.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  keys: UserSshKey[];
  isLoading: boolean;
  isAdding: boolean;
  pendingKeyId: string | null;
  error: string | null;
  onAdd: (input: { publicKey: string; name: string }) => Promise<boolean>;
  onDelete: (keyId: string) => void;
}

export function SshKeysPanel(props: Props) {
  const t = useTranslation();
  const lang = useLocale();

  const [isFormOpen, setIsFormOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [publicKey, setPublicKey] = createSignal("");

  function openForm() {
    setName("");
    setPublicKey("");
    setIsFormOpen(true);
  }

  async function submitForm(event: Event) {
    event.preventDefault();
    if (await props.onAdd({ publicKey: publicKey(), name: name() })) {
      setIsFormOpen(false);
    }
  }

  /** What the key has done, not what it is: the two things worth checking on. */
  function keySubtitle(key: UserSshKey): string {
    const used = key.lastUsedAt
      ? t("Last used {date}").replace("{date}", formatAbsoluteDate(key.lastUsedAt, lang))
      : t("Never used");
    return `${key.keyType} · ${used}`;
  }

  return (
    <section>
      <div class="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 class="font-semibold text-foreground text-size-medium">{t("SSH Keys")}</h2>
          <p class="mt-1 text-neutral-500 text-size-small">
            {t(
              "The CLI signs each request with a key registered here — no token is stored on the machine.",
            )}
          </p>
        </div>
        <Show when={!isFormOpen()}>
          <button
            type="button"
            onClick={openForm}
            class="shrink-0 font-medium text-blue-600 text-size-small hover:text-blue-800"
          >
            {t("+ New SSH key")}
          </button>
        </Show>
      </div>

      <Show when={props.error}>
        <div class="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2.5 text-red-600 text-size-small">
          {props.error}
        </div>
      </Show>

      <Show
        when={isFormOpen()}
        fallback={
          <Show
            when={!props.isLoading}
            fallback={
              <div class="divide-y divide-neutral-100 rounded-md border border-neutral-100">
                <For each={[0, 1]}>
                  {() => (
                    <div class="flex items-center gap-3 px-4 py-2.5">
                      <div class="h-7 w-7 shrink-0 animate-pulse rounded-full bg-neutral-100" />
                      <div class="flex-1 space-y-1.5">
                        <div class="h-3 w-1/3 animate-pulse rounded bg-neutral-100" />
                        <div class="h-2.5 w-2/5 animate-pulse rounded bg-neutral-100" />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <Show
              when={props.keys.length > 0}
              fallback={
                <div class="flex flex-col items-center justify-center rounded-md border border-neutral-100 border-dashed p-5 text-center">
                  <Icon class="h-6 w-6 text-neutral-400" name="lock-element" />
                  <p class="mt-2 text-neutral-500 text-size-small">
                    {t("No SSH keys yet.")}
                  </p>
                </div>
              }
            >
              <div class="divide-y divide-neutral-100 rounded-md border border-neutral-100">
                <For each={props.keys}>
                  {(key) => (
                    <div class="flex items-center gap-3 px-4 py-2.5 hover:bg-neutral-50">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-neutral-900 text-size-medium">
                          {key.name}
                        </div>
                        <div class="text-neutral-500 text-size-small">
                          {keySubtitle(key)}
                        </div>
                        {/* The fingerprint is how a key is told apart from the
                            others on the machine it lives on. */}
                        <div class="mt-0.5 break-all font-mono text-label text-neutral-500">
                          {key.fingerprint}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={props.pendingKeyId === key.id}
                        onClick={() => props.onDelete(key.id)}
                        class="shrink-0 text-red-600 text-size-small hover:text-red-800 disabled:opacity-50"
                      >
                        {t("Delete")}
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        }
      >
        <form
          onSubmit={(event) => void submitForm(event)}
          class="space-y-3 rounded-lg border border-neutral-200 bg-background p-3"
        >
          <div>
            <label
              for="ssh-key-name"
              class="mb-1 block font-medium text-neutral-700 text-size-small"
            >
              {t("Name")}
            </label>
            <input
              id="ssh-key-name"
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              type="text"
              placeholder={t("e.g. Work laptop")}
              class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
            />
          </div>

          <div>
            <label
              for="ssh-key-public"
              class="mb-1 block font-medium text-neutral-700 text-size-small"
            >
              {t("Public key")}
            </label>
            <textarea
              id="ssh-key-public"
              value={publicKey()}
              onInput={(event) => setPublicKey(event.currentTarget.value)}
              required
              rows={4}
              placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5… you@laptop"
              class="focus-ring w-full resize-y rounded-md border border-neutral-100 px-3 py-1.5 font-mono text-size-small"
            />
          </div>

          <p class="text-label text-neutral-500">
            {t("Paste the contents of a .pub file — never the private key.")}
          </p>

          <div class="flex justify-end gap-2">
            <Button
              size="small"
              variant="ghost"
              text={t("Cancel")}
              onClick={() => setIsFormOpen(false)}
            />
            <Button
              type="submit"
              size="small"
              disabled={props.isAdding}
              text={props.isAdding ? t("Adding…") : t("Add SSH key")}
            />
          </div>
        </form>
      </Show>
    </section>
  );
}
