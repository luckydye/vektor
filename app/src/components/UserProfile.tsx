import { createMemo, createSignal, onMount, Show } from "solid-js";
import {
  preferencesIcon,
  sendFeedbackIcon,
  signOutIcon,
  sourceCodeIcon,
} from "#assets/icons.ts";
import { authClient } from "#composeables/auth-client.ts";
import { useCosmetics } from "#composeables/useCosmetics.solid.ts";
import { useUserProfile } from "#composeables/useUserProfile.solid.ts";
import { t } from "#utils/lang.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
} from "#utils/themePreference.ts";
import "./AvatarElement.ts";
import "@atrium-ui/elements/popover";
import { UserPreferencesPanel } from "./UserPreferencesPanel.tsx";

export function UserProfile() {
  const profileUser = useUserProfile();
  const { appearance } = useCosmetics();
  applyThemePreference(getStoredThemePreference());

  // No `isMounted` guard: `useUserProfile` already returns an empty accessor on
  // the server, so there is nothing to withhold — the value simply arrives
  // after the session lookup resolves.
  const user = createMemo(() => {
    const resolved = profileUser();
    return resolved ? { ...resolved, appearance: appearance() } : undefined;
  });

  const [isPreferencesOpen, setPreferencesOpen] = createSignal(false);
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
        class="focus-ring mx-1.5 my-2 block overflow-visible rounded-full"
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
            class={`origin-bottom-left scale-95 rounded-lg border border-neutral-100 transition-all duration-150 group-[[enabled]]:scale-100 ${width()}`}
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

              <div class="p-[4px]">
                <button
                  type="button"
                  onClick={() => setPreferencesOpen(true)}
                  class="flex w-full items-center gap-2.5 rounded-lg px-3xs py-3xs text-left text-foreground text-size-small transition-colors duration-200 hover:bg-neutral-50"
                >
                  <div class="svg-icon h-4 w-4" innerHTML={preferencesIcon} />
                  <span class="font-medium leading-none">{t("Preferences")}</span>
                </button>
                <a
                  href="mailto:t.havlicek@s-v.de"
                  class="flex w-full items-center gap-2.5 rounded-lg px-3xs py-3xs text-left text-foreground text-size-small transition-colors duration-200 hover:bg-neutral-50"
                >
                  <div class="svg-icon h-4 w-4" innerHTML={sendFeedbackIcon} />
                  <span class="font-medium leading-none">{t("Send feedback")}</span>
                </a>
                <a
                  href="https://github.com/luckydye/vektor"
                  class="flex w-full items-center gap-2.5 rounded-lg px-3xs py-3xs text-left text-foreground text-size-small transition-colors duration-200 hover:bg-neutral-50"
                >
                  <div class="svg-icon h-4 w-4" innerHTML={sourceCodeIcon} />
                  <span class="font-medium leading-none">{t("Source")}</span>
                </a>
                <button
                  type="button"
                  onClick={handleLogout}
                  class="flex w-full items-center gap-2.5 rounded-lg px-3xs py-3xs text-left text-red-600 text-size-small transition-colors duration-200 hover:bg-red-50"
                >
                  <div class="svg-icon h-4 w-4" innerHTML={signOutIcon} />
                  <span class="font-medium leading-none">{t("Sign Out")}</span>
                </button>
              </div>
            </Show>

            <div
              // A real element, so Solid handles the boolean correctly; the
              // `attr:` form is only needed on custom elements, which take the
              // value verbatim and would render `hidden="false"`.
              hidden={!isPreferencesOpen()}
              class="preferences-panel w-[620px] max-w-[calc(100vw-2rem)]"
            >
              <UserPreferencesPanel onClose={() => setPreferencesOpen(false)} />
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  );
}
