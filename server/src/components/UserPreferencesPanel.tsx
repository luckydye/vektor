import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onMount,
  Show,
} from "solid-js";
import { isPermission } from "#acl/permissions.ts";
import {
  api,
  type OAuthIntegrationConnection,
  type OAuthIntegrationProvider,
  type PersonalAccessToken,
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
import { desktopApp } from "#utils/nativeApp.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
  storeThemePreference,
  type ThemePreference,
} from "#utils/themePreference.ts";
import { AccessTokensPanel } from "./AccessTokensPanel.tsx";
import { Button } from "./Button.tsx";
import { CosmeticsPanel } from "./CosmeticsPanel.tsx";
import { DesktopAppPreferences } from "./DesktopAppPreferences.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { SwitchToggle } from "./SwitchToggle.tsx";
import { confirmDialog } from "#composeables/useDialogs.ts";

interface Props {
  section: PreferencesSection;
  onClose?: () => void;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void | Promise<void>) => void;
};

const sections = [
  { id: "general", label: "Preferences", icon: "preferences" },
  // { id: "cosmetics", label: "Profile" },
  { id: "integrations", label: "Integrations", icon: "extension" },
  { id: "tokens", label: "Access Tokens", icon: "lock-element" },
  { id: "desktop", label: "Desktop App", icon: "presentation" },
] as const satisfies { id: string; label: TranslationKey; icon: IconName }[];

export type PreferencesSection = (typeof sections)[number]["id"];

const sectionLabels = Object.fromEntries(
  sections.map((section) => [section.id, section.label]),
) as Record<PreferencesSection, TranslationKey>;

// Only the desktop app mounts spaces, so its section is absent in a browser and on phones.
const app = desktopApp();

/** The profile menu's entries, one per preferences section. */
export const preferenceSections = app
  ? sections
  : sections.filter((section) => section.id !== "desktop");

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
  /** Creating a token takes the list's place; the header opens it. */
  const [isTokenFormOpen, setIsTokenFormOpen] = createSignal(false);
  const canOpenTokenForm = () =>
    props.section === "tokens" &&
    tokenSpaces().length > 0 &&
    !isTokenFormOpen() &&
    !accessTokens.createdToken();

  function openTokenForm() {
    accessTokens.dismissCreatedToken();
    setIsTokenFormOpen(true);
  }

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

  const revokeToken = async (token: PersonalAccessToken) => {
    if (
      !(await confirmDialog(
        t("Revoke this token? Anything using it stops working immediately."),
        { tone: "danger", confirmLabel: t("Revoke") },
      ))
    )
      return;
    void accessTokens.revoke(token);
  };

  const deleteToken = async (token: PersonalAccessToken) => {
    if (
      !(await confirmDialog(t("Delete this token permanently?"), {
        tone: "danger",
        confirmLabel: t("Delete"),
      }))
    )
      return;
    void accessTokens.remove(token);
  };

  const handleConnectIntegration = async (connection: OAuthIntegrationConnection) => {
    const spaceId = currentSpace()?.id;
    if (!spaceId) return;
    const provider = connection.provider;
    setConnectingProvider(provider);
    setIntegrationsError(null);

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

    void loadIntegrations();
    void loadNotificationPreference();
  });

  createEffect(() => {
    if (props.section !== "tokens") return;
    setIsTokenFormOpen(false);
    void accessTokens.load();
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
      <div class="flex items-center gap-2 border-(--menu-surface-border) border-b px-4 py-3">
        <button
          type="button"
          onClick={() => props.onClose?.()}
          class="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
          aria-label={t("Back to profile menu")}
        >
          <Icon class="h-4 w-4" name="chevron-left-large" />
        </button>
        <p class="flex-1 font-medium text-base text-foreground">
          {t(sectionLabels[props.section])}
        </p>
        <Show when={canOpenTokenForm()}>
          <Button size="small" icon="add" text={t("New token")} onClick={openTokenForm} />
        </Show>
      </div>

      <div
        class="min-h-[200px] px-4"
        classList={{ "py-2": props.section !== "desktop", "py-6": props.section === "desktop" }}
      >
        {(
          {
            general: () => (
              <>
              <div class="divide-y divide-(--menu-surface-border)">
                <fieldset class="flex items-center justify-between gap-4 py-3">
                  <legend class="sr-only">{t("Theme")}</legend>
                  <span class="font-medium text-foreground text-size-small">
                    {t("Theme")}
                  </span>
                  <div class="flex gap-0.5 rounded-lg bg-neutral-100 p-0.5">
                    <For each={themeOptions}>
                      {(option) => (
                        <button
                          type="button"
                          aria-pressed={themePreference() === option.value}
                          onClick={() => chooseThemePreference(option.value)}
                          class="flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-size-small transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                          classList={{
                            "text-neutral-500 hover:text-neutral-900":
                              themePreference() !== option.value,
                            "bg-background text-foreground shadow-sm":
                              themePreference() === option.value,
                          }}
                        >
                          <span
                            class={`h-3 w-3 shrink-0 rounded-full border border-neutral-300 ${option.swatchClass}`}
                          />
                          {t(option.label)}
                        </button>
                      )}
                    </For>
                  </div>
                </fieldset>

                <div class="flex items-center justify-between gap-4 py-3">
                  <span class="font-medium text-foreground text-size-small">
                    {t("Cursor color")}
                  </span>
                  <div class="flex items-center gap-3">
                    <Show when={!isAutomaticCursorColor()}>
                      <button
                        type="button"
                        onClick={clearCursorColor}
                        class="text-label text-neutral-500 transition-colors hover:text-neutral-900"
                      >
                        {t("Reset to automatic")}
                      </button>
                    </Show>
                    <a-popover-trigger>
                      <button
                        slot="trigger"
                        type="button"
                        class="-mr-2 flex items-center gap-2 rounded-lg py-1 pr-2 pl-2 text-foreground text-size-small transition-colors hover:bg-neutral-50"
                        attr:aria-label={t("Cursor color")}
                      >
                        <span
                          class="h-4 w-4 rounded-full shadow-[0_0_0_1px_rgba(128,128,128,0.4)]"
                          style={{ background: cursorColor() }}
                          aria-hidden="true"
                        />
                        {isAutomaticCursorColor() ? t("Automatic") : cursorColor()}
                      </button>
                      <a-popover class="group" placements="top-end">
                        <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                          <div class="origin-bottom-right scale-95 rounded-lg border border-neutral-100 bg-background p-2 shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
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
                </div>

                <Show when={currentSpace()?.id}>
                  <div class="flex items-center justify-between gap-4 py-3">
                    <span class="font-medium text-foreground text-size-small">
                      {t("Mute space notifications")}
                    </span>
                    <SwitchToggle
                      value={spaceNotificationsMuted()}
                      disabled={
                        isLoadingNotificationPreference() ||
                        isUpdatingNotificationPreference()
                      }
                      ariaLabel={t("Mute space notifications")}
                      onInput={(muted) => void muteSpaceNotifications(muted)}
                    />
                  </div>
                </Show>
              </div>
              <Show when={notificationPreferenceError()}>
                <div class="mt-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-600 text-size-small">
                  {notificationPreferenceError()}
                </div>
              </Show>
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
                isFormOpen={isTokenFormOpen()}
                onCloseForm={() => setIsTokenFormOpen(false)}
                onCreate={accessTokens.create}
                onDismissCreatedToken={accessTokens.dismissCreatedToken}
                onRevoke={revokeToken}
                onDelete={deleteToken}
              />
            ),

            integrations: () => (
              <>
                <Show when={integrationsError()}>
                  <div class="mb-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-600 text-size-small">
                    {integrationsError()}
                  </div>
                </Show>

                <Show
                  when={currentSpace()?.id}
                  fallback={
                    <p class="py-8 text-center text-neutral-500 text-size-small">
                      {t("Open a space to manage integrations.")}
                    </p>
                  }
                >
                  <Show
                    when={integrationCards().length > 0}
                    fallback={
                      <p class="py-8 text-center text-neutral-500 text-size-small">
                        {isLoadingIntegrations()
                          ? t("Loading...")
                          : t("Install an extension that provides an integration.")}
                      </p>
                    }
                  >
                    <div class="divide-y divide-(--menu-surface-border)">
                      <For each={integrationCards()}>
                        {(card) => (
                          <div class="py-3">
                            <div class="flex items-center gap-3">
                              <div
                                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg font-semibold text-size-small text-white"
                                style={{ "background-color": card.iconColor }}
                                aria-hidden="true"
                              >
                                {card.initial}
                              </div>
                              <div class="min-w-0 flex-1">
                                <p class="font-medium text-foreground text-size-small">
                                  {card.label}
                                </p>
                                <p
                                  class="truncate text-label"
                                  classList={{
                                    "text-green-700": !!card.connection?.connected,
                                    "text-amber-700":
                                      !card.connection?.connected &&
                                      card.connection?.configured === false,
                                    "text-neutral-500":
                                      !card.connection?.connected &&
                                      card.connection?.configured !== false,
                                  }}
                                  title={card.description ?? undefined}
                                >
                                  {card.connection?.connected
                                    ? `${t("Connected as")} ${card.connection.externalUsername || card.connection.externalAccountId}`
                                    : card.connection?.configured === false
                                      ? t("Not configured")
                                      : card.description}
                                </p>
                              </div>
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
                                    class="shrink-0 rounded-lg bg-blue-600 px-3 py-1 font-medium text-size-small text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
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
                                  class="shrink-0 rounded-lg px-3 py-1 font-medium text-red-600 text-size-small transition-colors hover:bg-red-50 disabled:opacity-50"
                                >
                                  {disconnectingProvider() === card.provider
                                    ? t("Disconnecting…")
                                    : t("Disconnect")}
                                </button>
                              </Show>
                            </div>

                            <Show
                              when={
                                card.connection?.connected && card.connection?.aiModelsPath
                              }
                            >
                              <label class="mt-3 flex items-center justify-between gap-3 pl-12 text-label text-neutral-600">
                                {t("Model for agent chats")}
                                <select
                                  class="form-control w-auto min-w-0 max-w-[55%] py-1 text-size-small"
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
                            </Show>
                            <Show
                              when={
                                card.connection?.connected && card.connection?.manageUrl
                              }
                            >
                              <a
                                href={card.connection?.manageUrl ?? undefined}
                                target="_blank"
                                rel="noopener noreferrer"
                                class="mt-2 inline-block pl-12 text-blue-600 text-label hover:underline"
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
                                class="mt-3 flex flex-col gap-1.5 pl-12"
                                onSubmit={(event) => {
                                  event.preventDefault();
                                  handleFinishPastedConnect(card.provider);
                                }}
                              >
                                <label
                                  class="text-label text-neutral-600"
                                  for={`paste-${card.provider}`}
                                >
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
                                  class="form-control px-2 py-1 text-size-small"
                                />
                                <Button
                                  type="submit"
                                  variant="neutral"
                                  size="small"
                                  class="justify-center"
                                  text={t("Finish connecting")}
                                />
                              </form>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </>
            ),
          } satisfies Record<PreferencesSection, () => JSX.Element>
        )[props.section]()}
      </div>
    </>
  );
}
