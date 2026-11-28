import { createComputed, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { isNoAuthMode } from "#config";
import { authClient } from "#composeables/auth-client.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
} from "#utils/themePreference.ts";
import "./AvatarElement.ts";
import "@atrium-ui/elements/popover";
import { useTranslation } from "#composeables/useTranslation.ts";
import { Icon } from "./Icon.tsx";
import {
  type PreferencesSection,
  preferenceSections,
  UserPreferencesPanel,
} from "./UserPreferencesPanel.tsx";
import { useToast } from "#composeables/useToast.ts";

export function UserProfile() {
  const t = useTranslation();

  const profileUser = useUserProfile();
  const { appearance } = useCosmetics();
  applyThemePreference(getStoredThemePreference());

  const user = createMemo(() => {
    const resolved = profileUser();
    return resolved ? { ...resolved, appearance: appearance() } : undefined;
  });

  /** The open preferences section; null shows the menu. */
  const [openSection, setOpenSection] = createSignal<PreferencesSection | null>(null);
  const isPreferencesOpen = () => openSection() !== null;
  // Kept once shown, so returning to the menu does not drop loaded state.
  const [shownSection, setShownSection] = createSignal<PreferencesSection | null>(null);
  createComputed(() => {
    const section = openSection();
    if (section) setShownSection(section);
  });
  const width = () =>
    !isPreferencesOpen()
      ? "w-[300px] max-w-[calc(100vw-2rem)]"
      : openSection() !== "desktop"
        ? "w-[400px] max-w-[calc(100vw-2rem)]"
        : "w-[620px] max-w-[calc(100vw-2rem)]";

  // The client reports a failed sign-out as a value, not a throw; reloading
  // regardless would look like signing out silently did nothing.
  async function handleLogout(event: MouseEvent) {
    const { error } = await authClient.signOut();
    if (error) {
      useToast().error(`${t("Sign out failed")}: ${error.message ?? error.statusText}`);
      return;
    }
    (event.target as Element | null)?.dispatchEvent(
      new CustomEvent("exit", { bubbles: true }),
    );
    window.location.reload();
  }

  // The integration callback redirects back here with its result in the query.
  // The preferences popover is closed after that reload, so the result is
  // reported as a toast, and dropped from the address so a reload does not
  // repeat it.
  onMount(() => {
    const url = new URL(window.location.href);
    const integration = url.searchParams.get("integration");
    const status = url.searchParams.get("status");
    if (!integration || !status) return;

    if (status === "connected") {
      useToast().success(
        t("{provider} connected successfully").replace("{provider}", integration),
      );
    } else {
      useToast().error(url.searchParams.get("message") || t("Integration OAuth failed"));
    }

    for (const name of ["integration", "status", "message"])
      url.searchParams.delete(name);
    history.replaceState(history.state, "", url);
  });

  return (
    <a-popover-trigger class="group relative z-10 block max-md:w-full">
      {/* On mobile the avatar heads a full-width row, as a native account cell does. */}
      <button
        slot="trigger"
        type="button"
        class="focus-ring mx-4xs my-2 flex items-center gap-3xs overflow-visible rounded-full max-md:w-[calc(100%-2*var(--spacing-4xs))] max-md:rounded-md"
      >
        <vektor-avatar prop:user={user()} />
        <span class="min-w-0 flex-1 truncate text-left font-medium text-neutral-900 text-size-normal md:hidden">
          {user()?.name || t("Anonymous User")}
        </span>
        <Icon class="h-4 w-4 flex-none text-neutral-400 md:hidden" name="chevron-right-thin" />
      </button>

      {/* A bottom sheet on phones, via `.popover-sheet`; the panel's own frame steps aside there. */}
      <a-popover
        class="group popover-sheet"
        placements="top-start"
        on:exit={() => setOpenSection(null)}
      >
        <div
          class={`overflow-hidden rounded-xl opacity-0 transition-[width,opacity] duration-150 ease-out group-[[enabled]]:opacity-100 max-md:overflow-visible max-md:rounded-none ${width()} max-md:max-w-none`}
        >
          <div
            class={`relative origin-bottom-left scale-95 rounded-xl surface-menu transition-all duration-150 group-[[enabled]]:scale-100 max-md:bg-background ${width()} max-md:w-full max-md:max-w-none`}
          >
            <Show when={!isPreferencesOpen()}>
              <div class="space-y-5xs p-5xs">
                <For each={preferenceSections}>
                  {(section) => (
                    <button
                      type="button"
                      onClick={() => setOpenSection(section.id)}
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs text-left text-interactive text-neutral-900 hover:bg-black/6 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/16"
                    >
                      <Icon class="h-4 w-4 flex-none" name={section.icon} />
                      <span>{t(section.label)}</span>
                    </button>
                  )}
                </For>
                <a
                  href="https://github.com/luckydye/vektor"
                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs text-left text-interactive text-neutral-900 hover:bg-black/6 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/16"
                >
                  <Icon class="h-4 w-4 flex-none" name="source-code" />
                  <span>{t("Source")}</span>
                </a>
                {/* No-auth mode signs every request in as the local user, so there is no session to end. */}
                <Show when={!isNoAuthMode()}>
                  <button
                    type="button"
                    onClick={handleLogout}
                    class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs text-left text-interactive text-red-600 hover:bg-black/6 active:bg-black/10 dark:hover:bg-white/10 dark:active:bg-white/16"
                  >
                    <Icon class="h-4 w-4 flex-none" name="sign-out" />
                    <span>{t("Sign Out")}</span>
                  </button>
                </Show>
              </div>

              <div class="border-(--menu-surface-border) border-t p-4">
                <div class="flex items-center gap-3">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-medium text-foreground text-size-medium">
                      {user()?.name || t("Anonymous User")}
                    </p>
                    <p class="truncate text-neutral-600 text-size-normal">
                      {user()?.email || t("No email")}
                    </p>
                  </div>
                </div>
              </div>
            </Show>

            <div hidden={!isPreferencesOpen()} class={`preferences-panel ${width()}`}>
              <Show when={shownSection()}>
                {(section) => (
                  <UserPreferencesPanel
                    section={section()}
                    onClose={() => setOpenSection(null)}
                  />
                )}
              </Show>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  );
}
