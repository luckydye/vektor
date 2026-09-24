import { createSignal, Show } from "solid-js";
import { authClient } from "#composeables/auth-client.ts";
import { type TranslationKey, t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";

interface Props {
  lang: string;
  challenge: string;
  name: string;
  email: string;
}

/**
 * Confirms handing this browser's sign-in to the desktop app. An explicit step,
 * so a link alone cannot sign an app in on someone's behalf.
 */
export function DesktopLogin(props: Props) {
  const translate = (key: TranslationKey) => t(key, props.lang);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function openApp() {
    setError(null);
    const { data, error } = await authClient.$fetch<{ code: string }>(
      "/desktop-handoff/start",
      { method: "POST", body: { challenge: props.challenge } },
    );
    if (error || !data) {
      setError(error?.message ?? translate("Authentication failed, mate!"));
      return;
    }
    window.location.href = `vektor-desktop://auth?code=${encodeURIComponent(data.code)}`;
    setSent(true);
  }

  return (
    <div class="w-full max-w-[360px] space-y-5">
      <div>
        <h2
          class="font-semibold text-neutral-900"
          style={{ "font-size": "1.6rem", "line-height": "1.2", "letter-spacing": "-0.02em" }}
        >
          {translate("Sign in to the Vektor app")}
        </h2>
        <p class="mt-1.5 text-neutral-500 text-size-medium">
          {props.name} · {props.email}
        </p>
      </div>
      <Show
        when={!sent()}
        fallback={
          <p class="text-neutral-500 text-size-medium">
            {translate("You can close this tab and return to the app.")}
          </p>
        }
      >
        <Button
          text={translate("Open the Vektor app")}
          class="w-full justify-center px-6 py-3 text-base"
          onClick={() => void openApp()}
        />
      </Show>
      <Show when={error()}>
        <p class="text-red-600 text-size-medium">{error()}</p>
      </Show>
    </div>
  );
}
