import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import {
  api,
  type OAuthIntegrationConnection,
  type OAuthIntegrationProvider,
} from "#api/client.ts";
import { chevronLeftLargeIcon } from "#assets/icons.ts";
import { useCanvasCursorColor } from "#composeables/useCanvasCursorColor.solid.ts";
import { useCosmetics } from "#composeables/useCosmetics.solid.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { useUserProfile } from "#composeables/useUserProfile.solid.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { t } from "#utils/lang.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "#utils/themePreference.ts";
import { CosmeticsPanel } from "./cosmetics/CosmeticsPanel.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";

interface Props {
  onClose?: () => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => void;
};

const tabs = [
  { id: "appearance", label: t("Appearance") },
  { id: "cosmetics", label: t("Cosmetics") },
  { id: "notifications", label: t("Notifications") },
  { id: "integrations", label: t("Integrations") },
];

const themeOptions: { value: ThemePreference; label: string; swatchClass: string }[] = [
  {
    value: "system",
    label: t("System"),
    swatchClass:
      "bg-[linear-gradient(135deg,#ffffff_0%,#ffffff_48%,#222222_52%,#222222_100%)]",
  },
  { value: "light", label: t("Light"), swatchClass: "bg-[#fff5b8]" },
  { value: "dark", label: t("Dark"), swatchClass: "bg-[#252525]" },
];

const integrationProviders: OAuthIntegrationProvider[] = ["gitlab", "youtrack"];

const integrationProviderDetails: Record<
  OAuthIntegrationProvider,
  { label: string; description: string; initial: string; iconClass: string }
> = {
  gitlab: {
    label: "GitLab",
    description: t("Connect GitLab to work with your projects and issues."),
    initial: "G",
    iconClass: "bg-[#fc6d26]",
  },
  youtrack: {
    label: "YouTrack",
    description: t("Connect YouTrack to work with your issues and projects."),
    initial: "Y",
    iconClass: "bg-[#4c57e8]",
  },
};

const EMPTY_PANEL_CLASS =
  "rounded-lg border border-dashed border-neutral-200 p-5 text-center text-neutral-500 text-size-small";
const LOADING_PANEL_CLASS =
  "rounded-lg border border-neutral-100 p-5 text-center text-neutral-500 text-size-small";

export function UserPreferencesPanel(props: Props) {
  const [themePreference, setThemePreference] = createSignal<ThemePreference>("system");
  const currentUser = useUserProfile();
  const {
    inventory: cosmeticInventory,
    loadout: cosmeticLoadout,
    appearance: cosmeticAppearance,
    equip: equipCosmetic,
  } = useCosmetics();
  // `null` means "automatic" — the presence color follows the user's avatar.
  const { cursorColorOverride, setCursorColor, clearCursorColor } =
    useCanvasCursorColor();
  const automaticCursorColor = createMemo(() => getAvatarColor(currentUser()?.id));
  const cursorColor = createMemo(() => cursorColorOverride() ?? automaticCursorColor());
  const isAutomaticCursorColor = createMemo(() => cursorColorOverride() === null);

  const [integrationConnections, setIntegrationConnections] = createSignal<
    OAuthIntegrationConnection[]
  >([]);
  const [isLoadingIntegrations, setIsLoadingIntegrations] = createSignal(false);
  const [integrationsError, setIntegrationsError] = createSignal<string | null>(null);
  const [integrationsMessage, setIntegrationsMessage] = createSignal<string | null>(null);
  const [connectingProvider, setConnectingProvider] =
    createSignal<OAuthIntegrationProvider | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] =
    createSignal<OAuthIntegrationProvider | null>(null);
  const [spaceNotificationsMuted, setSpaceNotificationsMuted] = createSignal(false);
  const [isLoadingNotificationPreference, setIsLoadingNotificationPreference] =
    createSignal(false);
  const [isUpdatingNotificationPreference, setIsUpdatingNotificationPreference] =
    createSignal(false);
  const [notificationPreferenceError, setNotificationPreferenceError] = createSignal<
    string | null
  >(null);
  const { currentSpace } = useSpace();

  const activeSpaceName = createMemo(() => currentSpace()?.name || null);

  const integrationCards = createMemo(() =>
    integrationProviders.map((provider) => ({
      provider,
      connection:
        integrationConnections().find((connection) => connection.provider === provider) ??
        null,
      ...integrationProviderDetails[provider],
    })),
  );

  const applyThemePreferenceWithTransition = (preference: ThemePreference) => {
    const updateTheme = () => {
      setThemePreference(preference);
      applyThemePreference(preference);
    };
    const viewTransitionDocument = document as ViewTransitionDocument;

    if (
      !viewTransitionDocument.startViewTransition ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      updateTheme();
      return;
    }

    viewTransitionDocument.startViewTransition(updateTheme);
  };

  const chooseThemePreference = (preference: ThemePreference) => {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    applyThemePreferenceWithTransition(preference);
  };

  const loadIntegrations = async () => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) {
      setIntegrationConnections([]);
      return;
    }

    setIsLoadingIntegrations(true);
    setIntegrationsError(null);

    try {
      const response = await api.integrations.get(spaceId);
      setIntegrationConnections(response.connections || []);
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Failed to load integrations"),
      );
      setIntegrationConnections([]);
    } finally {
      setIsLoadingIntegrations(false);
    }
  };

  const loadNotificationPreference = async () => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) {
      setSpaceNotificationsMuted(false);
      return;
    }

    setIsLoadingNotificationPreference(true);
    setNotificationPreferenceError(null);

    try {
      const response = await api.space.getNotificationPreference(spaceId);
      setSpaceNotificationsMuted(response.muted);
    } catch (error) {
      setNotificationPreferenceError(
        error instanceof Error
          ? error.message
          : t("Failed to load notification preference"),
      );
    } finally {
      setIsLoadingNotificationPreference(false);
    }
  };

  const muteSpaceNotifications = async (muted: boolean) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId || isUpdatingNotificationPreference()) return;

    setIsUpdatingNotificationPreference(true);
    setNotificationPreferenceError(null);

    try {
      const response = await api.space.setNotificationMuted(spaceId, muted);
      setSpaceNotificationsMuted(response.muted);
    } catch (error) {
      setNotificationPreferenceError(
        error instanceof Error
          ? error.message
          : t("Failed to update notification preference"),
      );
    } finally {
      setIsUpdatingNotificationPreference(false);
    }
  };

  const handleConnectIntegration = async (provider: OAuthIntegrationProvider) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setConnectingProvider(provider);
    setIntegrationsError(null);
    setIntegrationsMessage(null);

    try {
      const redirectTo = `${window.location.pathname}${window.location.search}`;
      const response = await api.integrations.connect(spaceId, provider, { redirectTo });
      window.location.href = response.authorizeUrl;
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Failed to start OAuth flow"),
      );
      setConnectingProvider(null);
    }
  };

  const handleDisconnectIntegration = async (provider: OAuthIntegrationProvider) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    if (!confirm(t("Disconnect {provider}?").replace("{provider}", provider))) return;
    setDisconnectingProvider(provider);
    setIntegrationsError(null);
    setIntegrationsMessage(null);

    try {
      await api.integrations.disconnect(spaceId, provider);
      await loadIntegrations();
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Failed to disconnect integration"),
      );
    } finally {
      setDisconnectingProvider(null);
    }
  };

  onMount(() => {
    const savedPreference = getStoredThemePreference();
    setThemePreference(savedPreference);
    applyThemePreference(savedPreference);

    const url = new URL(window.location.href);
    const integrationStatus = url.searchParams.get("status");
    const integrationName = url.searchParams.get("integration");
    const integrationMessage = url.searchParams.get("message");
    if (integrationStatus === "connected" && integrationName) {
      setIntegrationsMessage(
        t("{provider} connected successfully").replace("{provider}", integrationName),
      );
    } else if (integrationStatus === "error") {
      setIntegrationsError(integrationMessage || t("Integration OAuth failed"));
    }

    void loadIntegrations();
    void loadNotificationPreference();
  });

  createEffect(
    on(
      () => currentSpace()?.id,
      () => {
        void loadIntegrations();
        void loadNotificationPreference();
      },
      { defer: true },
    ),
  );

  return (
    <>
      {/* Header */}
      <div class="flex items-center gap-2 border-neutral-100 border-b px-4 py-3">
        <button
          type="button"
          onClick={() => props.onClose?.()}
          class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          aria-label={t("Back to profile menu")}
        >
          <div class="svg-icon h-4 w-4" innerHTML={chevronLeftLargeIcon} />
        </button>
        <p class="font-medium text-base text-foreground">{t("Preferences")}</p>
      </div>

      {/* Tabbed settings layout */}
      <SettingsLayout
        tabs={tabs}
        class="min-h-[200px] w-[620px] max-w-[calc(100vw-2rem)]"
        panels={{
          appearance: () => (
            <>
              <section>
                <div class="mb-3">
                  <h2 class="font-semibold text-foreground text-size-medium">
                    {t("Interface")}
                  </h2>
                  <p class="mt-1 text-neutral-500 text-size-small">
                    {t("Choose how Vektor looks on this device.")}
                  </p>
                </div>
                <div class="rounded-lg border border-neutral-200 bg-background p-3">
                  <p class="font-medium text-foreground text-size-small">{t("Theme")}</p>
                  {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> would bring a legend and its own layout; this is a labelled group of buttons, not a form control set. */}
                  <div
                    class="mt-3 grid grid-cols-3 gap-3"
                    role="group"
                    aria-label={t("Theme")}
                  >
                    <For each={themeOptions}>
                      {(option) => (
                        <button
                          type="button"
                          aria-pressed={themePreference() === option.value}
                          onClick={() => chooseThemePreference(option.value)}
                          class="group flex flex-col items-center gap-1.5 rounded-md px-2 py-1 font-medium text-neutral-500 text-size-small transition-colors hover:text-neutral-900"
                        >
                          <span
                            class="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-200 p-0.5 transition-transform group-hover:scale-105"
                            classList={{
                              "ring-2 ring-primary-500 ring-offset-2":
                                themePreference() === option.value,
                            }}
                          >
                            <span
                              class={`h-full w-full rounded-full ${option.swatchClass}`}
                            />
                          </span>
                          <span>{option.label}</span>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </section>

              <section class="mt-6">
                <div class="mb-3">
                  <h2 class="font-semibold text-foreground text-size-medium">
                    {t("Collaboration")}
                  </h2>
                  <p class="mt-1 text-neutral-500 text-size-small">
                    {t("Personalize how you appear to collaborators.")}
                  </p>
                </div>
                <div class="rounded-lg border border-neutral-200 bg-background p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <p class="font-medium text-foreground text-size-small">
                        {t("Cursor color")}
                      </p>
                      <p class="mt-0.5 text-label text-neutral-500">
                        {t("Used for your presence in shared documents and canvases.")}
                      </p>
                    </div>
                    <Show when={!isAutomaticCursorColor()}>
                      <button
                        type="button"
                        onClick={clearCursorColor}
                        class="shrink-0 font-medium text-label text-neutral-500 transition-colors hover:text-neutral-900"
                      >
                        {t("Reset to automatic")}
                      </button>
                    </Show>
                  </div>
                  <a-popover-trigger>
                    <button
                      slot="trigger"
                      type="button"
                      class="mt-3 flex w-full items-center justify-between gap-3 rounded-md border border-neutral-200 bg-background px-3 py-2 text-foreground text-size-medium transition-colors hover:bg-neutral-50"
                      aria-label={t("Cursor color")}
                    >
                      <span class="flex items-center gap-2">
                        <span
                          class="h-5 w-5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(15,23,42,0.2),0_1px_2px_rgba(15,23,42,0.18)]"
                          style={{ background: cursorColor() }}
                          aria-hidden="true"
                        />
                        <span>
                          {isAutomaticCursorColor() ? t("Automatic") : cursorColor()}
                        </span>
                      </span>
                      <span class="font-medium text-label text-neutral-500">
                        {t("Change")}
                      </span>
                    </button>
                    <a-popover class="group" placements="top-start">
                      <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                        <div class="origin-bottom-left scale-95 rounded-lg border border-neutral-100 bg-background p-2 shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
                          <a-color-picker
                            class="w-[220px]"
                            attr:value={cursorColor()}
                            on:change={(event: Event) =>
                              setCursorColor(
                                (event.target as HTMLElement & { value: string }).value,
                              )
                            }
                          />
                        </div>
                      </div>
                    </a-popover>
                  </a-popover-trigger>
                </div>
              </section>
            </>
          ),

          cosmetics: () => (
            <CosmeticsPanel
              inventory={cosmeticInventory}
              loadout={cosmeticLoadout()}
              appearance={cosmeticAppearance()}
              user={currentUser()}
              onEquip={equipCosmetic}
            />
          ),

          notifications: () => (
            <section>
              <div class="mb-3">
                <p class="text-neutral-500 text-size-small">
                  {t("Manage notifications for the current space.")}
                </p>
              </div>

              <Show when={notificationPreferenceError()}>
                <div class="mb-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-600 text-size-small">
                  {notificationPreferenceError()}
                </div>
              </Show>

              <Show
                when={currentSpace()?.id}
                fallback={
                  <div class={EMPTY_PANEL_CLASS}>
                    {t("Open a space to manage notifications.")}
                  </div>
                }
              >
                <Show
                  when={!isLoadingNotificationPreference()}
                  fallback={<div class={LOADING_PANEL_CLASS}>{t("Loading...")}</div>}
                >
                  <div class="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-background p-3">
                    <div>
                      <p class="font-medium text-foreground text-size-small">
                        {t("Mute space notifications")}
                      </p>
                      <p class="mt-0.5 text-label text-neutral-500">
                        {t("Stop email notifications from this space.")}
                      </p>
                    </div>
                    <SwitchToggle
                      value={spaceNotificationsMuted()}
                      disabled={isUpdatingNotificationPreference()}
                      onInput={(muted) => void muteSpaceNotifications(muted)}
                    />
                  </div>
                </Show>
              </Show>
            </section>
          ),

          integrations: () => (
            <section>
              <div class="mb-4">
                <h2 class="font-semibold text-foreground text-size-medium">
                  {t("Integrations")}
                </h2>
                <p class="mt-1 text-neutral-500 text-size-small">
                  {t("Connect tools to make them available in this space.")}
                </p>
                <p class="mt-2 text-label text-neutral-500">
                  {t("Space:")}{" "}
                  <span class="font-medium text-foreground">
                    {activeSpaceName() || t("None")}
                  </span>
                </p>
              </div>

              <Show when={integrationsError()}>
                <div class="mb-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-600 text-size-small">
                  {integrationsError()}
                </div>
              </Show>
              <Show when={integrationsMessage()}>
                <div class="mb-3 rounded-md border border-green-200 bg-green-50 p-2.5 text-green-700 text-size-small">
                  {integrationsMessage()}
                </div>
              </Show>

              <Show
                when={currentSpace()?.id}
                fallback={
                  <div class={EMPTY_PANEL_CLASS}>
                    {t("Open a space to manage integrations.")}
                  </div>
                }
              >
                <Show
                  when={!isLoadingIntegrations()}
                  fallback={<div class={LOADING_PANEL_CLASS}>{t("Loading...")}</div>}
                >
                  <div class="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
                    <For each={integrationCards()}>
                      {(card) => (
                        <div class="flex min-h-[254px] flex-col rounded-lg border border-neutral-200 bg-background p-4">
                          <div class="flex items-start justify-between gap-3">
                            <div
                              class={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-semibold text-size-large text-white ${card.iconClass}`}
                              aria-hidden="true"
                            >
                              {card.initial}
                            </div>
                            <span
                              class="inline-flex rounded-full px-2 py-0.5 font-medium text-label"
                              classList={{
                                "bg-green-50 text-green-700":
                                  !!card.connection?.connected,
                                "bg-neutral-100 text-neutral-500":
                                  !card.connection?.connected,
                              }}
                            >
                              {card.connection?.connected
                                ? t("Connected")
                                : t("Not connected")}
                            </span>
                          </div>

                          <div class="mt-4">
                            <h3 class="font-semibold text-foreground text-size-medium">
                              {card.connection?.label || card.label}
                            </h3>
                            <p class="mt-1 text-neutral-500 text-size-small leading-5">
                              {card.description}
                            </p>
                          </div>

                          <div class="mt-3 min-h-10 text-label">
                            <Show when={card.connection?.connected}>
                              <p class="text-neutral-600">
                                {t("Connected as")}{" "}
                                {card.connection?.externalUsername ||
                                  card.connection?.externalAccountId}
                              </p>
                            </Show>
                            <Show
                              when={
                                !card.connection?.connected &&
                                card.connection?.configured === false
                              }
                            >
                              <p class="text-amber-700">{t("Not configured")}</p>
                            </Show>
                            <Show
                              when={
                                !card.connection?.connected &&
                                card.connection?.configured !== false &&
                                card.connection?.instanceUrl
                              }
                            >
                              <p class="truncate text-neutral-500">
                                {card.connection?.instanceUrl}
                              </p>
                            </Show>
                          </div>

                          <div class="mt-auto border-neutral-100 border-t pt-3">
                            <Show
                              when={card.connection?.connected}
                              fallback={
                                <button
                                  type="button"
                                  disabled={
                                    connectingProvider() === card.provider ||
                                    card.connection?.configured === false
                                  }
                                  onClick={() =>
                                    void handleConnectIntegration(card.provider)
                                  }
                                  class="w-full rounded-md bg-blue-600 px-3 py-1.5 font-medium text-size-small text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {connectingProvider() === card.provider
                                    ? t("Redirecting…")
                                    : t("Connect")}
                                </button>
                              }
                            >
                              <button
                                type="button"
                                disabled={disconnectingProvider() === card.provider}
                                onClick={() =>
                                  void handleDisconnectIntegration(card.provider)
                                }
                                class="w-full rounded-md border border-red-200 px-3 py-1.5 font-medium text-red-600 text-size-small transition-colors hover:bg-red-50 disabled:opacity-50"
                              >
                                {disconnectingProvider() === card.provider
                                  ? t("Disconnecting…")
                                  : t("Disconnect")}
                              </button>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </section>
          ),
        }}
      />
    </>
  );
}
