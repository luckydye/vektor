import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { PersonalAccessToken, Space } from "#api/client.ts";
import type {
  CreatedPersonalToken,
  CreatePersonalTokenInput,
} from "#composeables/usePersonalAccessTokens.ts";
import {
  type AccessTokenStatus,
  roleBadgeClass,
  tokenRole,
  tokenStatus,
  tokenStatusClass,
} from "#utils/accessToken.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import "./AvatarElement.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  tokens: PersonalAccessToken[];
  /** Spaces a token can be minted for: the ones the user holds a role on. */
  spaces: Space[];
  defaultSpaceId: string | null;
  isLoading: boolean;
  isCreating: boolean;
  pendingTokenId: string | null;
  createdToken: CreatedPersonalToken | null;
  error: string | null;
  onCreate: (input: CreatePersonalTokenInput) => Promise<boolean>;
  onDismissCreatedToken: () => void;
  onRevoke: (token: PersonalAccessToken) => void;
  onDelete: (token: PersonalAccessToken) => void;
}

export function AccessTokensPanel(props: Props) {
  const t = useTranslation();
  const lang = useLocale();

  const expiryOptions = (): { days: number | null; label: string }[] => [
    { days: 30, label: t("30 days") },
    { days: 90, label: t("90 days") },
    { days: 365, label: t("1 year") },
    { days: null, label: t("No expiration") },
  ];

  const statusLabel = (status: AccessTokenStatus): string =>
    ({ Active: t("Active"), Expired: t("Expired"), Revoked: t("Revoked") })[status];

  const [isFormOpen, setIsFormOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [spaceId, setSpaceId] = createSignal("");
  const [expiresInDays, setExpiresInDays] = createSignal<number | null>(30);
  const [copied, setCopied] = createSignal(false);

  /**
   * One region, one thing in it: creating a token and reading its secret take
   * the list's place rather than stacking above it, so nothing below moves.
   */
  const view = createMemo<"form" | "created" | "list">(() => {
    if (isFormOpen()) return "form";
    return props.createdToken ? "created" : "list";
  });

  function openForm() {
    setName("");
    setSpaceId(props.defaultSpaceId ?? props.spaces[0]?.id ?? "");
    setExpiresInDays(30);
    props.onDismissCreatedToken();
    setIsFormOpen(true);
  }

  async function submitForm(event: Event) {
    event.preventDefault();
    setCopied(false);
    const created = await props.onCreate({
      name: name(),
      spaceId: spaceId(),
      expiresInDays: expiresInDays(),
    });
    if (created) setIsFormOpen(false);
  }

  async function copyToken() {
    const value = props.createdToken?.token; // solid-reactivity-ok: click handler, reads per click
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  function tokenSubtitle(token: PersonalAccessToken): string {
    const used = token.lastUsedAt
      ? t("Last used {date}").replace(
          "{date}",
          formatAbsoluteDate(token.lastUsedAt, lang),
        )
      : t("Never used");
    const expiry = token.expiresAt
      ? t("Expires {date}").replace("{date}", formatAbsoluteDate(token.expiresAt, lang))
      : null;
    return [token.spaceName, used, expiry].filter(Boolean).join(" · ");
  }

  return (
    <section>
      <Show when={props.spaces.length > 0 && view() === "list"}>
        <div class="mb-1 flex justify-end">
          <button
            type="button"
            onClick={openForm}
            class="rounded-lg px-2 py-1 font-medium text-blue-600 text-size-small transition-colors hover:bg-blue-50"
          >
            {t("+ New token")}
          </button>
        </div>
      </Show>

      <Show when={props.error}>
        <div class="mb-3 rounded-md border border-red-500/20 bg-red-500/10 p-2.5 text-red-600 text-size-small">
          {props.error}
        </div>
      </Show>

      {/* A floor for every state, so loading, empty and full do not resize the panel. */}
      <div>
        <Switch>
          <Match when={view() === "form"}>
            <form
              onSubmit={(event) => void submitForm(event)}
              class="space-y-3"
            >
              <div>
                <label
                  for="personal-token-name"
                  class="mb-1 block font-medium text-neutral-700 text-size-small"
                >
                  {t("Name")}
                </label>
                <input
                  id="personal-token-name"
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  type="text"
                  required
                  placeholder={t("e.g. Laptop CLI")}
                  class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                />
              </div>

              <div class="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
                <div>
                  <label
                    for="personal-token-space"
                    class="mb-1 block font-medium text-neutral-700 text-size-small"
                  >
                    {t("Space")}
                  </label>
                  <select
                    id="personal-token-space"
                    value={spaceId()}
                    onChange={(event) => setSpaceId(event.currentTarget.value)}
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                  >
                    <For each={props.spaces}>
                      {(space) => <option value={space.id}>{space.name}</option>}
                    </For>
                  </select>
                </div>
                <div>
                  <label
                    for="personal-token-expiry"
                    class="mb-1 block font-medium text-neutral-700 text-size-small"
                  >
                    {t("Expiration")}
                  </label>
                  <select
                    id="personal-token-expiry"
                    value={String(expiresInDays() ?? "")}
                    onChange={(event) =>
                      setExpiresInDays(
                        event.currentTarget.value
                          ? Number(event.currentTarget.value)
                          : null,
                      )
                    }
                    class="focus-ring w-full rounded-md border border-neutral-100 px-3 py-1.5 text-size-medium"
                  >
                    <For each={expiryOptions()}>
                      {(option) => (
                        <option value={option.days ?? ""}>{option.label}</option>
                      )}
                    </For>
                  </select>
                </div>
              </div>

              <p class="text-label text-neutral-500">
                {t("The token carries your own role on the space and nothing more.")}
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
                  disabled={props.isCreating}
                  text={props.isCreating ? t("Creating…") : t("Create token")}
                />
              </div>
            </form>
          </Match>

          <Match when={view() === "created"}>
            <div class="rounded-lg border border-green-500/20 bg-green-500/10 p-3">
              <p class="font-medium text-green-700 text-size-small">
                {t("Copy your token now — it is never shown again.")}
              </p>
              <div class="mt-3 flex items-center gap-2">
                <code class="min-w-0 flex-1 select-all break-all rounded-sm border border-green-500/20 bg-background px-2 py-1.5 font-mono text-size-small">
                  {props.createdToken?.token}
                </code>
                <Button
                  size="small"
                  variant="outline"
                  text={copied() ? t("Copied!") : t("Copy")}
                  onClick={() => void copyToken()}
                />
              </div>
              <p class="mt-3 text-neutral-600 text-size-small">
                {t("Space ID, which callers name along with the token:")}{" "}
                <code class="select-all font-mono">{props.createdToken?.spaceId}</code>
              </p>
              <div class="mt-3 flex justify-end">
                <Button
                  size="small"
                  text={t("Done")}
                  onClick={() => {
                    props.onDismissCreatedToken();
                    setCopied(false);
                  }}
                />
              </div>
            </div>
          </Match>

          <Match when={view() === "list"}>
            <Show
              when={!props.isLoading}
              fallback={
                <div class="divide-y divide-neutral-100">
                  <For each={[0, 1, 2]}>
                    {() => (
                      <div class="flex items-center gap-3 py-3">
                        <div class="h-7 w-7 shrink-0 animate-pulse rounded-full bg-skeleton" />
                        <div class="flex-1 space-y-1.5">
                          <div class="h-3 w-1/3 animate-pulse rounded bg-skeleton" />
                          <div class="h-2.5 w-2/5 animate-pulse rounded bg-skeleton" />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              }
            >
              <Show
                when={props.tokens.length > 0}
                fallback={
                  <div class="flex flex-col items-center justify-center py-8 text-center">
                    <Icon class="h-6 w-6 text-neutral-400" name="lock-element" />
                    <p class="mt-2 text-neutral-500 text-size-small">
                      {props.spaces.length === 0
                        ? t("Join a space to create an access token.")
                        : t("No access tokens yet.")}
                    </p>
                  </div>
                }
              >
                <div class="divide-y divide-neutral-100">
                  <For each={props.tokens}>
                    {(token) => (
                      <div class="group flex items-center gap-3 py-3">
                        <vektor-avatar
                          size="32"
                          attr:user-id={token.id}
                          kind="credential"
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="truncate font-medium text-foreground text-size-small">
                              {token.name}
                            </span>
                            <span
                              class={`shrink-0 rounded-full px-1.5 py-px font-medium text-label ${roleBadgeClass(tokenRole(token))}`}
                            >
                              {tokenRole(token)}
                            </span>
                            {/* Active is the default, so only say what is wrong. */}
                            <Show when={tokenStatus(token) !== "Active"}>
                              <span
                                class={`shrink-0 rounded-sm px-1.5 py-px text-label ${tokenStatusClass(tokenStatus(token))}`}
                              >
                                {statusLabel(tokenStatus(token))}
                              </span>
                            </Show>
                          </div>
                          <p class="truncate text-label text-neutral-500">
                            {tokenSubtitle(token)}
                          </p>
                        </div>
                        <div class="flex shrink-0 gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <Show when={!token.revokedAt}>
                            <button
                              type="button"
                              disabled={props.pendingTokenId === token.id}
                              onClick={() => props.onRevoke(token)}
                              class="rounded-md px-2 py-1 text-label text-red-600 hover:bg-red-50 disabled:opacity-50"
                            >
                              {t("Revoke")}
                            </button>
                          </Show>
                          <button
                            type="button"
                            disabled={props.pendingTokenId === token.id}
                            onClick={() => props.onDelete(token)}
                            class="rounded-md px-2 py-1 text-label text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
                          >
                            {t("Delete")}
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Match>
        </Switch>
      </div>
    </section>
  );
}
