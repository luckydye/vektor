import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { isPermission } from "#acl/permissions.ts";
import {
  api,
  type OAuthIntegrationConnection,
  type OAuthIntegrationProvider,
} from "#api/client.ts";
import { useQueryClient } from "#composeables/query.ts";
import { useCanvasCursorColor } from "#composeables/useCanvasCursorColor.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { useDesktopMounts } from "#composeables/useDesktopMounts.ts";
import { integrationsQueryKey } from "#composeables/useIntegrationAIModel.ts";
import { usePersonalAccessTokens } from "#composeables/usePersonalAccessTokens.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import type { TranslationKey } from "#utils/lang.ts";
import { nativeApp } from "#utils/nativeApp.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
  storeThemePreference,
  type ThemePreference,
} from "#utils/themePreference.ts";
import { AccessTokensPanel } from "./AccessTokensPanel.tsx";
import { CosmeticsPanel } from "./CosmeticsPanel.tsx";
import { DesktopAppPreferences } from "./DesktopAppPreferences.tsx";
import { Icon } from "./Icon.tsx";
import { SettingsLayout } from "./SettingsLayout.tsx";
import { SettingsSection } from "./SettingsSection.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";
import { confirmDialog } from "#composeables/useDialogs.ts";

interface Props {
  onClose?: () => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => void;
};

const tabs = [
  { id: "general", label: "General" },
  // { id: "cosmetics", label: "Profile" },
  { id: "integrations", label: "Integrations" },
  { id: "tokens", label: "Access Tokens" },
] satisfies { id: string; label: TranslationKey }[];

// Only the desktop app announces itself, so the tab is absent in a browser.
const app = nativeApp();
const visibleTabs = app
  ? [...tabs, { id: "desktop", label: "Desktop App" as const }]
  : tabs;

const themeOptions: {
  value: ThemePreference;
  label: TranslationKey;
  swatchClass: string;
}[] = [
  {
    value: "system",
    label: "System",
    swatchClass:
      "bg-[linear-gradient(135deg,#ffffff_0%,#ffffff_48%,#222222_52%,#222222_100%)]",
  },
  { value: "light", label: "Light", swatchClass: "bg-[#fff5b8]" },
  { value: "dark", label: "Dark", swatchClass: "bg-[#252525]" },
];

export function UserPreferencesPanel(props: Props) {
  const t = useTranslation();

  const [themePreference, setThemePreference] = createSignal<ThemePreference>("system");
  const currentUser = useUserProfile();
  const {
    inventory: cosmeticInventory,
    loadout: cosmeticLoadout,
    appearance: cosmeticAppearance,
    equip: equipCosmetic,
  } = useCosmetics();
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
  // A provider that redirects to a loopback address hands its result back
  // through the address the user pastes here.
  const [pastingProvider, setPastingProvider] =
    createSignal<OAuthIntegrationProvider | null>(null);
  const [pastedAddress, setPastedAddress] = createSignal("");
  const [aiModels, setAIModels] = createSignal<Record<string, string[]>>({});
  const [updatingModelProvider, setUpdatingModelProvider] =
    createSignal<OAuthIntegrationProvider | null>(null);
  const [spaceNotificationsMuted, setSpaceNotificationsMuted] = createSignal(false);
  const [isLoadingNotificationPreference, setIsLoadingNotificationPreference] =
    createSignal(false);
  const [isUpdatingNotificationPreference, setIsUpdatingNotificationPreference] =
    createSignal(false);
  const [notificationPreferenceError, setNotificationPreferenceError] = createSignal<
    string | null
  >(null);
  const { currentSpace, currentSpaceId, spaces } = useSpace();
  const accessTokens = usePersonalAccessTokens();
  const queryClient = useQueryClient();

  // A token delegates its issuer's role on the space, so a space reached only
  // through a document grant has no role to delegate and cannot mint one.
  const tokenSpaces = createMemo(() =>
    (spaces() ?? []).filter((space) => isPermission(space.userRole)),
  );

  // Providers come from the space's installed extensions, so the cards are
  // whatever the API returned rather than a list the app knows in advance.
  const integrationCards = createMemo(() =>
    integrationConnections().map((connection) => ({
      provider: connection.provider,
      connection,
      label: connection.label,
      description: connection.description,
      initial: connection.label.trim().charAt(0).toUpperCase() || "?",
      iconColor: getAvatarColor(connection.provider),
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
    storeThemePreference(preference);
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
      void loadAIModels(spaceId, response.connections || []);
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Failed to load integrations"),
      );
      setIntegrationConnections([]);
    } finally {
      setIsLoadingIntegrations(false);
    }
  };

  const loadAIModels = async (
    spaceId: string,
    connections: OAuthIntegrationConnection[],
  ) => {
    const providing = connections.filter(
      (connection) => connection.connected && connection.aiModelsPath,
    );
    try {
      const lists = await Promise.all(
        providing.map(
          async (connection) =>
            [
              connection.provider,
              await api.integrations.listAIModels(spaceId, connection),
            ] as const,
        ),
      );
      setAIModels(Object.fromEntries(lists));
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Failed to load models"),
      );
    }
  };

  const handleSelectAIModel = async (
    provider: OAuthIntegrationProvider,
    aiModel: string | null,
  ) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setUpdatingModelProvider(provider);
    setIntegrationsError(null);

    try {
      await api.integrations.setAIModel(spaceId, provider, aiModel);
      queryClient.invalidateQueries({ queryKey: integrationsQueryKey(spaceId) });
      await loadIntegrations();
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Failed to update model"),
      );
    } finally {
      setUpdatingModelProvider(null);
    }
  };

  const handleFinishPastedConnect = (provider: OAuthIntegrationProvider) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    setIntegrationsError(null);

    try {
      window.location.href = api.integrations.pastedCallbackUrl(
        spaceId,
        provider,
        pastedAddress(),
      );
    } catch (error) {
      setIntegrationsError(
        error instanceof Error ? error.message : t("Integration OAuth failed"),
      );
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

  const revokeToken = async (tokenId: string) => {
    if (
      !(await confirmDialog(
        t("Revoke this token? Anything using it stops working immediately."),
        { tone: "danger", confirmLabel: t("Revoke") },
      ))
    )
      return;
    void accessTokens.revoke(tokenId);
  };

  const deleteToken = async (tokenId: string) => {
    if (!(await confirmDialog(t("Delete this token permanently?"), {
        tone: "danger",
        confirmLabel: t("Delete"),
      })))
      return;
    void accessTokens.remove(tokenId);
  };

  const handleConnectIntegration = async (connection: OAuthIntegrationConnection) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    const provider = connection.provider;
    setConnectingProvider(provider);
    setIntegrationsError(null);
    setIntegrationsMessage(null);

    try {
      const redirectTo = `${window.location.pathname}${window.location.search}`;
      const response = await api.integrations.connect(spaceId, provider, { redirectTo });
      if (connection.pastesRedirect) {
        // The provider's redirect lands on a page that does not load, so the
        // sign-in runs in its own tab while this one waits for the address.
        window.open(response.authorizeUrl, "_blank", "noopener");
        setPastedAddress("");
        setPastingProvider(provider);
        setConnectingProvider(null);
        return;
      }
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
    if (
      !(await confirmDialog(t("Disconnect {provider}?").replace("{provider}", provider), {
        tone: "danger",
      }))
    )
      return;
    setDisconnectingProvider(provider);
    setIntegrationsError(null);
    setIntegrationsMessage(null);

    try {
      await api.integrations.disconnect(spaceId, provider);
      queryClient.invalidateQueries({ queryKey: integrationsQueryKey(spaceId) });
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
      currentSpaceId,
      () => {
        void loadIntegrations();
        void loadNotificationPreference();
      },
      { defer: true },
    ),
  );

  return (
    <>
      <div class="flex items-center gap-2 border-neutral-100 border-b px-4 py-3">
        <button
          type="button"
          onClick={() => props.onClose?.()}
          class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          aria-label={t("Back to profile menu")}
        >
          <Icon class="h-4 w-4" name="chevron-left-large" />
        </button>
        <p class="font-medium text-base text-foreground">{t("Preferences")}</p>
      </div>

      <SettingsLayout
        tabs={visibleTabs.map((tab) => ({ ...tab, label: t(tab.label) }))}
        onTabChange={(id) => {
          if (id === "tokens") void accessTokens.load();
        }}
        class="min-h-[200px] w-[620px] max-w-[calc(100vw-2rem)]"
        panels={{
          general: () => (
            <>
              <SettingsSection
                title={t("Interface")}
                description={t("Choose how Vektor looks on this device.")}
              >
                <fieldset class="grid grid-cols-3 gap-2">
                  <legend class="sr-only">{t("Theme")}</legend>
                  <For each={themeOptions}>
                    {(option) => (
                      <button
                        type="button"
                        aria-pressed={themePreference() === option.value}
                        onClick={() => chooseThemePreference(option.value)}
                        class="flex min-h-11 items-center justify-center gap-2 rounded-md border px-2 font-medium text-size-small transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        classList={{
                          "border-neutral-200 bg-background text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900":
                            themePreference() !== option.value,
                          "border-primary-500 bg-primary-50 text-foreground":
                            themePreference() === option.value,
                        }}
                      >
                        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-200 p-0.5">
                          <span
                            class={`h-full w-full rounded-full ${option.swatchClass}`}
                          />
                        </span>
                        <span>{t(option.label)}</span>
                      </button>
                    )}
                  </For>
                </fieldset>
              </SettingsSection>

              <SettingsSection
                title={t("Collaboration")}
                description={t("Personalize how you appear to collaborators.")}
              >
                <div class="flex items-center justify-start gap-5 rounded-lg border border-neutral-200 bg-background p-3">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <p class="font-medium text-foreground text-size-small">
                        {t("Cursor color")}
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
                      class="flex w-full items-center justify-between gap-3 rounded-md border border-neutral-200 bg-background px-3 py-2 text-foreground text-size-medium transition-colors hover:bg-neutral-50"
                      attr:aria-label={t("Cursor color")}
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
              </SettingsSection>

              <SettingsSection
                title={t("Notifications")}
                description={t("Manage notifications for the current space.")}
              >
                <Show when={notificationPreferenceError()}>
                  <div class="mb-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-600 text-size-small">
                    {notificationPreferenceError()}
                  </div>
                </Show>

                <Show
                  when={currentSpace()?.id}
                  fallback={
                    <div class="rounded-lg border border-neutral-200 border-dashed p-5 text-center text-neutral-500 text-size-small">
                      {t("Open a space to manage notifications.")}
                    </div>
                  }
                >
                  <Show
                    when={!isLoadingNotificationPreference()}
                    fallback={
                      <div class="rounded-lg border border-neutral-100 p-5 text-center text-neutral-500 text-size-small">
                        {t("Loading...")}
                      </div>
                    }
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
              </SettingsSection>
            </>
          ),

          // cosmetics: () => (
          //   <CosmeticsPanel
          //     inventory={cosmeticInventory}
          //     loadout={cosmeticLoadout()}
          //     appearance={cosmeticAppearance()}
          //     user={currentUser()}
          //     onEquip={equipCosmetic}
          //   />
          // ),

          desktop: () => (
            <Show when={app}>
              {(app) => {
                const desktopMounts = useDesktopMounts();
                return (
                  <DesktopAppPreferences
                    app={app()}
                    spaces={tokenSpaces()}
                    currentSpaceId={currentSpaceId()}
                    mounts={desktopMounts.mounts()}
                    error={desktopMounts.error()}
                    onMount={desktopMounts.mount}
                    onAuthorize={(mount) => void desktopMounts.authorize(mount)}
                    onUnmount={desktopMounts.unmount}
                    onReveal={desktopMounts.reveal}
                  />
                );
              }}
            </Show>
          ),

          tokens: () => (
            <AccessTokensPanel
              tokens={accessTokens.tokens()}
              spaces={tokenSpaces()}
              defaultSpaceId={currentSpaceId()}
              isLoading={accessTokens.isLoading()}
              isCreating={accessTokens.isCreating()}
              pendingTokenId={accessTokens.pendingTokenId()}
              createdToken={accessTokens.createdToken()}
              error={accessTokens.error()}
              onCreate={accessTokens.create}
              onDismissCreatedToken={accessTokens.dismissCreatedToken}
              onRevoke={revokeToken}
              onDelete={deleteToken}
            />
          ),

          integrations: () => (
            <section>
              <div class="mb-4">
                <p class="text-neutral-500 text-size-small">
                  {t("Connect tools to make them available in this space.")}
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
                  <div class="flex min-h-[236px] flex-col items-center justify-center rounded-lg border border-neutral-200 border-dashed p-5 text-center text-neutral-500 text-size-small">
                    {t("Open a space to manage integrations.")}
                  </div>
                }
              >
                <Show
                  when={!isLoadingIntegrations()}
                  fallback={
                    <div class="flex min-h-[236px] flex-col items-center justify-center rounded-lg border border-neutral-100 p-5 text-center text-neutral-500 text-size-small">
                      {t("Loading...")}
                    </div>
                  }
                >
                  <Show
                    when={integrationCards().length > 0}
                    fallback={
                      <div class="flex min-h-[236px] flex-col items-center justify-center rounded-lg border border-neutral-200 border-dashed p-5 text-center text-neutral-500 text-size-small">
                        {t("Install an extension that provides an integration.")}
                      </div>
                    }
                  >
                    <div class="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
                      <For each={integrationCards()}>
                        {(card) => (
                          <div class="flex min-h-[254px] flex-col rounded-lg border border-neutral-200 bg-background p-4">
                            <div class="flex items-start justify-between gap-3">
                              <div
                                class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-semibold text-size-large text-white"
                                style={{ "background-color": card.iconColor }}
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
                                {card.label}
                              </h3>
                              <Show when={card.description}>
                                <p class="mt-1 text-neutral-500 text-size-small leading-5">
                                  {card.description}
                                </p>
                              </Show>
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
                                  card.connection?.connected &&
                                  card.connection?.aiModelsPath
                                }
                              >
                                <label class="mt-2 block text-neutral-600">
                                  {t("Model for agent chats")}
                                  <select
                                    class="mt-1 block w-full rounded-md border border-neutral-200 bg-background px-2 py-1 text-size-small"
                                    disabled={updatingModelProvider() === card.provider}
                                    onChange={(event) =>
                                      void handleSelectAIModel(
                                        card.provider,
                                        event.currentTarget.value || null,
                                      )
                                    }
                                  >
                                    <option value="" selected={!card.connection?.aiModel}>
                                      {t("Instance default")}
                                    </option>
                                    <For each={aiModels()[card.provider] ?? []}>
                                      {(model) => (
                                        <option
                                          value={model}
                                          selected={card.connection?.aiModel === model}
                                        >
                                          {model}
                                        </option>
                                      )}
                                    </For>
                                  </select>
                                </label>
                                <Show when={card.connection?.aiModel}>
                                  <p class="mt-1 text-green-700">
                                    {t("Runs your agent chats")}
                                  </p>
                                </Show>
                              </Show>
                              <Show
                                when={card.connection?.connected && card.connection?.manageUrl}
                              >
                                <a
                                  href={card.connection?.manageUrl ?? undefined}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  class="mt-1 inline-block text-blue-600 hover:underline"
                                >
                                  {t("Manage usage")}
                                </a>
                              </Show>
                              <Show
                                when={
                                  !card.connection?.connected &&
                                  pastingProvider() === card.provider
                                }
                              >
                                <form
                                  class="flex flex-col gap-1.5"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    handleFinishPastedConnect(card.provider);
                                  }}
                                >
                                  <label class="text-neutral-600" for={`paste-${card.provider}`}>
                                    {t("Paste the address you landed on after signing in")}
                                  </label>
                                  <input
                                    id={`paste-${card.provider}`}
                                    type="url"
                                    required
                                    value={pastedAddress()}
                                    onInput={(event) =>
                                      setPastedAddress(event.currentTarget.value)
                                    }
                                    class="rounded-md border border-neutral-200 bg-background px-2 py-1 text-size-small"
                                  />
                                  <button
                                    type="submit"
                                    class="rounded-md border border-neutral-200 px-3 py-1 font-medium text-size-small hover:bg-neutral-50"
                                  >
                                    {t("Finish connecting")}
                                  </button>
                                </form>
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
                                      void handleConnectIntegration(card.connection)
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
              </Show>
            </section>
          ),
        }}
      />
    </>
  );
}
