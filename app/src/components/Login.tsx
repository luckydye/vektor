import { createSignal, Show } from "solid-js";
import { authClient } from "#composeables/auth-client.ts";
import { config } from "#config";
import { type TranslationKey, t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";
import { FormField } from "./FormField.tsx";
import { Input } from "./Input.tsx";

interface Props {
  lang?: string;
}

export function Login(props: Props) {
  const translate = (key: TranslationKey) => t(key, props.lang);

  const conf = config();
  const showPasswordLogin = conf.AUTH_LOGIN !== "false";
  const showSsoLogin = !!conf.OAUTH_PROVIDER_ID;
  const showGoogleLogin = conf.GOOGLE_AUTH_ENABLED === "1";

  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [name, setName] = createSignal("");
  const [isSignUp, setIsSignUp] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  async function onOAuthLogin() {
    if (!conf.OAUTH_PROVIDER_ID) {
      throw new Error("OAUTH_PROVIDER_ID is not configured");
    }

    await authClient.signIn.oauth2({
      providerId: conf.OAUTH_PROVIDER_ID,
      callbackURL: "/",
      errorCallbackURL: "/error",
      newUserCallbackURL: "/",
      disableRedirect: false,
      scopes: ["email", "profile", "openid"],
      requestSignUp: false,
    });
  }

  async function onGoogleLogin() {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/error",
      newUserCallbackURL: "/",
    });
  }

  async function onEmailLogin() {
    if (!email() || !password()) {
      setError(translate("Email and password are required, mate!"));
      return;
    }

    if (isSignUp() && !name()) {
      setError(translate("Name is required for sign up"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      if (isSignUp()) {
        const response = await fetch("/api/auth/sign-up/email", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: email(),
            password: password(),
            name: name(),
          }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.message || translate("Sign up failed"));
        }

        window.location.href = "/";
      } else {
        const result = await authClient.signIn.email({
          email: email(),
          password: password(),
          callbackURL: "/",
        });

        if (!result.error) {
          window.location.href = "/";
        } else {
          throw new Error(result.error.message || translate("Sign in failed"));
        }
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : translate("Authentication failed, mate!"),
      );
    } finally {
      setLoading(false);
    }
  }

  function toggleMode() {
    setIsSignUp(!isSignUp());
    setError("");
  }

  return (
    <div class="w-full space-y-5">
      <Show when={showPasswordLogin || showSsoLogin || showGoogleLogin}>
        <div class="mb-7">
          <h2
            class="font-semibold text-neutral-900"
            style={{
              "font-size": "1.6rem",
              "line-height": "1.2",
              "letter-spacing": "-0.02em",
            }}
          >
            {isSignUp() ? translate("Create an account") : translate("Welcome back")}
          </h2>
          <p class="mt-1.5 text-neutral-500 text-size-medium">
            {isSignUp()
              ? translate("Set up your Vektor workspace")
              : translate("Sign in to your workspace")}
          </p>
        </div>
      </Show>

      <Show when={showPasswordLogin}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onEmailLogin();
          }}
          class="space-y-4"
        >
          <Show when={isSignUp()}>
            <FormField label={translate("Name")}>
              <Input
                value={name()}
                onInput={setName}
                placeholder={translate("Your Name")}
                type="text"
                disabled={loading()}
              />
            </FormField>
          </Show>

          <FormField label={translate("Email")}>
            <Input
              value={email()}
              onInput={setEmail}
              placeholder={translate("your.email@example.com")}
              type="email"
              disabled={loading()}
            />
          </FormField>

          <FormField label={translate("Password")}>
            <Input
              value={password()}
              onInput={setPassword}
              placeholder="••••••••"
              type="password"
              disabled={loading()}
            />
          </FormField>

          <Show when={error()}>
            <div class="rounded-sm bg-red-50 p-2 text-red-600 text-size-medium">
              {error()}
            </div>
          </Show>

          <Button
            text={
              loading()
                ? translate("Loading...")
                : isSignUp()
                  ? translate("Sign Up")
                  : translate("Sign In")
            }
            class="w-full justify-center px-6 py-3 text-base"
            type="submit"
            disabled={loading()}
          />

          <button
            type="button"
            onClick={toggleMode}
            class="w-full text-neutral-500 text-size-medium transition-colors hover:text-neutral-700"
            disabled={loading()}
          >
            {isSignUp()
              ? translate("Already have an account? Sign in")
              : translate("Need an account? Sign up")}
          </button>
        </form>
      </Show>

      <Show when={showPasswordLogin && (showSsoLogin || showGoogleLogin)}>
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <div class="w-full border-neutral border-t" />
          </div>
          <div class="relative flex justify-center text-size-medium">
            <span class="bg-background px-2 text-neutral">{translate("Or")}</span>
          </div>
        </div>
      </Show>

      <Show when={showGoogleLogin}>
        <Button
          variant="secondary"
          text={translate("Continue with Google")}
          class="w-full justify-center px-6 py-3 text-base"
          onClick={() => void onGoogleLogin()}
          disabled={loading()}
        />
      </Show>

      <Show when={showSsoLogin}>
        <Button
          variant="secondary"
          text={translate("Continue with SSO")}
          class="w-full justify-center px-6 py-3 text-base"
          onClick={() => void onOAuthLogin()}
          disabled={loading()}
        />
      </Show>

      <Show when={!showPasswordLogin && !showSsoLogin && !showGoogleLogin}>
        <div class="text-center text-neutral text-size-medium">
          {translate("No login method configured.")}
        </div>
      </Show>
    </div>
  );
}
