import { createEffect, createMemo, createSignal, onMount, Show } from "solid-js";
import { authClient } from "#composeables/auth-client.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { t } from "#utils/lang.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
} from "#utils/themePreference.ts";
import "./AvatarElement.ts";
import "@atrium-ui/elements/popover";
import { Icon } from "./Icon.tsx";
import { UserPreferencesPanel } from "./UserPreferencesPanel.tsx";

export function UserProfile() {
  const profileUser = useUserProfile();
  const { appearance } = useCosmetics();
  applyThemePreference(getStoredThemePreference());

  const user = createMemo(() => {
    const resolved = profileUser();
    return resolved ? { ...resolved, appearance: appearance() } : undefined;
  });

  const [isPreferencesOpen, setPreferencesOpen] = createSignal(false);
  const [hasOpenedPreferences, setHasOpenedPreferences] = createSignal(false);
  createEffect(() => {
    if (isPreferencesOpen()) setHasOpenedPreferences(true);
  });
  const width = () =>
    isPreferencesOpen()
      ? "w-[620px] max-w-[calc(100vw-2rem)]"
      : "w-[300px] max-w-[calc(100vw-2rem)]";

  async function handleLogout(event: MouseEvent) {
    try {
      await authClient.signOut();
      (event.target as Element | null)?.dispatchEvent(
        new CustomEvent("exit", { bubbles: true }),
      );
      window.location.reload();
    } catch (error) {
      console.error("Logout failed:", error);
    }
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("integration") && params.get("status")) setPreferencesOpen(true);
  });

  return (
    <a-popover-trigger class="group relative z-10 block">
      <button
        slot="trigger"
        type="button"
        class="focus-ring mx-4xs my-2 block overflow-visible rounded-full"
      >
        <vektor-avatar prop:user={user()} />
      </button>

      <a-popover
        class="group"
        placements="top-start"
        on:exit={() => setPreferencesOpen(false)}
      >
        <div
          class={`overflow-hidden rounded-lg bg-background opacity-0 shadow-xl transition-[width,opacity] duration-150 ease-out group-[[enabled]]:opacity-100 ${width()}`}
        >
          <div
            class={`relative origin-bottom-left scale-95 rounded-lg border border-neutral-100 transition-all duration-150 group-[[enabled]]:scale-100 ${width()}`}
          >
            <Show when={!isPreferencesOpen()}>
              <div class="border-neutral-100 border-b p-4">
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

              <div class="space-y-5xs p-[4px]">
                <button
                  type="button"
                  onClick={() => setPreferencesOpen(true)}
                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100 group-aria-selected:bg-primary-10"
                >
                  <Icon class="h-4 w-4" name="preferences" />
                  <span class="text-interactive">{t("Preferences")}</span>
                </button>
                <a
                  href="mailto:t.havlicek@s-v.de"
                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100 group-aria-selected:bg-primary-10"
                >
                  <Icon class="h-4 w-4" name="send-feedback" />
                  <span class="text-interactive">{t("Send feedback")}</span>
                </a>
                <a
                  href="https://github.com/luckydye/vektor"
                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs transition-colors hover:bg-primary-50 hover:transition-none active:bg-primary-100 group-aria-selected:bg-primary-10"
                >
                  <Icon class="h-4 w-4" name="source-code" />
                  <span class="text-interactive">{t("Source")}</span>
                </a>
                <button
                  type="button"
                  onClick={handleLogout}
                  class="flex w-full items-center gap-2.5 rounded-md px-3xs py-5xs pr-4xs text-left text-red-600 text-size-small transition-colors hover:bg-red-500 hover:text-white"
                >
                  <Icon class="h-4 w-4" name="sign-out" />
                  <span class="text-interactive">{t("Sign Out")}</span>
                </button>
              </div>
            </Show>

            <div
              hidden={!isPreferencesOpen()}
              class="preferences-panel w-[620px] max-w-[calc(100vw-2rem)]"
            >
              <Show when={hasOpenedPreferences()}>
                <UserPreferencesPanel onClose={() => setPreferencesOpen(false)} />
              </Show>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  );
}
