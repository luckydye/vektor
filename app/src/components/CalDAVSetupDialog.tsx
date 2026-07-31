import { createSignal, onCleanup, Show } from "solid-js";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { Actions } from "#utils/actions.ts";
import { t } from "#utils/lang.ts";
import { Dialog } from "./Dialog.tsx";

export function CalDAVSetupDialog() {
  const [show, setShow] = createSignal(false);
  const [copied, setCopied] = createSignal<string | null>(null);
  const user = useUserProfile();

  const serverUrl = () => (typeof window !== "undefined" ? window.location.origin : "");

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  Actions.register("caldav:setup", {
    title: t("CalDAV Setup"),
    description: t("Show CalDAV calendar integration setup guide"),
    group: "settings",
    run: async () => {
      setShow(true);
    },
  });

  onCleanup(() => Actions.unregister("caldav:setup"));

  return (
    <Dialog
      show={show()}
      onUpdateShow={setShow}
      title="CalDAV Setup"
      maxWidth="md:max-w-lg"
    >
      <div class="flex flex-col gap-xs">
        <p class="text-neutral-500 text-small">
          Connect your calendar app to sync wiki documents as events.
        </p>

        <ol class="flex list-none flex-col gap-xs">
          <li class="flex flex-col gap-4xs">
            <span class="font-medium text-small">1. Create an access token</span>
            <span class="text-neutral-500 text-small">
              Open a Space → Settings → Access Tokens, create a token with <em>viewer</em>{" "}
              permission.
            </span>
          </li>

          <li class="flex flex-col gap-4xs">
            <span class="font-medium text-small">
              2. Add a CalDAV account in your calendar app
            </span>
            <span class="text-neutral-500 text-small">Use these credentials:</span>

            <div class="flex flex-col gap-4xs">
              <div class="flex items-center gap-4xs">
                <span class="w-24 shrink-0 text-neutral-400 text-small">Server URL</span>
                <button
                  type="button"
                  class="flex-1 truncate rounded-sm bg-neutral-100 px-3xs py-5xs text-left font-mono text-small transition-colors hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                  title={serverUrl()}
                  onClick={() => void copy(serverUrl(), "url")}
                >
                  {serverUrl()}
                </button>
                <Show when={copied() === "url"}>
                  <span class="shrink-0 text-green-500 text-small">Copied!</span>
                </Show>
              </div>

              <div class="flex items-center gap-4xs">
                <span class="w-24 shrink-0 text-neutral-400 text-small">Username</span>
                <button
                  type="button"
                  class="flex-1 truncate rounded-sm bg-neutral-100 px-3xs py-5xs text-left font-mono text-small transition-colors hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-700"
                  title={user()?.email}
                  onClick={() => {
                    const email = user()?.email;
                    if (email) void copy(email, "email");
                  }}
                >
                  {user()?.email ?? "—"}
                </button>
                <Show when={copied() === "email"}>
                  <span class="shrink-0 text-green-500 text-small">Copied!</span>
                </Show>
              </div>

              <div class="flex items-center gap-4xs">
                <span class="w-24 shrink-0 text-neutral-400 text-small">Password</span>
                <span class="flex-1 rounded-sm bg-neutral-100 px-3xs py-5xs font-mono text-neutral-500 text-small italic dark:bg-neutral-800">
                  access token from step 1
                </span>
              </div>
            </div>
          </li>
        </ol>
      </div>
    </Dialog>
  );
}
