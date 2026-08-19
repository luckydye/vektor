import { For, Show } from "solid-js";
import { t } from "#utils/lang.ts";
import "./AvatarElement.ts";

export interface OverviewUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  /** The IdP group claim their access is decided by, already formatted. */
  groups: string[];
  /** When the account first signed in, already formatted for display. */
  joined: string;
}

interface Props {
  users: OverviewUser[];
  loading?: boolean;
  error?: string | null;
}

/**
 * Every account on the instance, which only an admin may read — the page that
 * mounts this decides that, since the same rule is what makes the tab visible.
 */
export function UsersOverview(props: Props) {
  return (
    <div class="space-y-8 px-xs pt-m pb-20 lg:px-xl">
      <div class="flex items-center justify-between gap-3xs">
        <h1 class="font-semibold text-foreground text-size-title">{t("Users")}</h1>
        <Show when={!props.loading && !props.error}>
          <span class="text-neutral-500 text-size-small">
            {props.users.length === 1
              ? t("1 user")
              : t("{count} users").replace("{count}", String(props.users.length))}
          </span>
        </Show>
      </div>

      <Show when={props.error}>
        <div class="rounded-md border border-red-200 bg-red-50 p-4">
          <p class="text-red-600 text-size-medium">{props.error}</p>
        </div>
      </Show>

      <Show when={props.loading}>
        <div class="space-y-3xs">
          <For each={[0, 1, 2, 3, 4]}>
            {() => <div class="h-11 animate-pulse rounded-md bg-neutral-100" />}
          </For>
        </div>
      </Show>

      <Show when={!props.loading && !props.error && props.users.length === 0}>
        <div class="rounded-lg border border-neutral-400/25 border-dashed p-l text-center">
          <p class="text-neutral-600">{t("No accounts have signed in yet.")}</p>
        </div>
      </Show>

      <Show when={!props.loading && props.users.length > 0}>
        <div class="overflow-x-auto rounded-md border border-neutral-100">
          <table class="min-w-full text-size-medium">
            <thead class="bg-neutral-50">
              <tr>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("User")}
                </th>
                <th class="px-4 py-2.5 text-left font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Groups")}
                </th>
                <th class="px-4 py-2.5 text-right font-medium text-neutral-500 text-size-small uppercase tracking-wide">
                  {t("Joined")}
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-neutral-100">
              <For each={props.users}>
                {(user) => (
                  <tr class="hover:bg-neutral-50">
                    <td class="px-4 py-2.5">
                      <div class="flex items-center gap-3">
                        <vektor-avatar
                          size="28"
                          attr:user-id={user.id}
                          prop:user={user}
                        />
                        <div class="min-w-0">
                          <div class="truncate font-medium text-neutral-900">
                            {user.name}
                          </div>
                          <div class="truncate text-neutral-500 text-size-small">
                            {user.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td class="px-4 py-2.5">
                      <Show
                        when={user.groups.length > 0}
                        fallback={<span class="text-neutral-400">—</span>}
                      >
                        <div class="flex flex-wrap gap-5xs">
                          <For each={user.groups}>
                            {(group) => (
                              <span class="rounded-sm bg-neutral-100 px-4xs py-6xs text-neutral-700 text-size-small">
                                {group}
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>
                    </td>
                    <td class="whitespace-nowrap px-4 py-2.5 text-right text-neutral-600">
                      {user.joined}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
