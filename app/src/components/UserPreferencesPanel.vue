<script setup lang="ts">
import { withViewTransition } from "#utils/viewTransition.ts";
import Button from "./Button.vue";
import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  api,
  type OAuthIntegrationConnection,
  type OAuthIntegrationProvider,
} from "#api/client.ts";
import { chevronLeftLargeIcon } from "#assets/icons.ts";
import { useCanvasCursorColor } from "#composeables/useCanvasCursorColor.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { t } from "#utils/lang.ts";
import {
  applyThemePreference,
  getStoredThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "#utils/themePreference.ts";
import CosmeticsPanel from "./cosmetics/CosmeticsPanel.vue";
import SettingsLayout from "./SettingsLayout.vue";
import SwitchToggle from "./SwitchToggle.vue";

const themePreference = ref<ThemePreference>("system");
const currentUser = useUserProfile();
const {
  inventory: cosmeticInventory,
  loadout: cosmeticLoadout,
  appearance: cosmeticAppearance,
  equip: equipCosmetic,
} = useCosmetics();
// `null` means "automatic" — the presence color follows the user's avatar.
const { cursorColorOverride, setCursorColor, clearCursorColor } = useCanvasCursorColor();
const automaticCursorColor = computed(() => getAvatarColor(currentUser.value?.id));
const cursorColor = computed(
  () => cursorColorOverride.value ?? automaticCursorColor.value,
);
const isAutomaticCursorColor = computed(() => cursorColorOverride.value === null);
const integrationProviders: OAuthIntegrationProvider[] = ["gitlab", "youtrack"];
const integrationConnections = ref<OAuthIntegrationConnection[]>([]);
const isLoadingIntegrations = ref(false);
const integrationsError = ref<string | null>(null);
const integrationsMessage = ref<string | null>(null);
const connectingProvider = ref<OAuthIntegrationProvider | null>(null);
const disconnectingProvider = ref<OAuthIntegrationProvider | null>(null);
const spaceNotificationsMuted = ref(false);
const isLoadingNotificationPreference = ref(false);
const isUpdatingNotificationPreference = ref(false);
const notificationPreferenceError = ref<string | null>(null);
const { currentSpace } = useSpace();

const emit = defineEmits<{
  close: [];
}>();

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

const activeSpaceName = computed(() => currentSpace.value?.name || null);

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

const integrationCards = computed(() =>
  integrationProviders.map((provider) => ({
    provider,
    connection:
      integrationConnections.value.find(
        (connection) => connection.provider === provider,
      ) ?? null,
    ...integrationProviderDetails[provider],
  })),
);

const applyThemePreferenceWithTransition = (preference: ThemePreference) => {
  const updateTheme = async () => {
    themePreference.value = preference;
    applyThemePreference(preference);
    await nextTick();
  };
  void withViewTransition(updateTheme);
};

const setThemePreference = (preference: ThemePreference) => {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyThemePreferenceWithTransition(preference);
};

const loadIntegrations = async () => {
  if (!currentSpace.value?.id) {
    integrationConnections.value = [];
    return;
  }

  isLoadingIntegrations.value = true;
  integrationsError.value = null;

  try {
    const response = await api.integrations.get(currentSpace.value.id);
    integrationConnections.value = response.connections || [];
  } catch (error) {
    integrationsError.value =
      error instanceof Error ? error.message : t("Failed to load integrations");
    integrationConnections.value = [];
  } finally {
    isLoadingIntegrations.value = false;
  }
};

const loadNotificationPreference = async () => {
  if (!currentSpace.value?.id) {
    spaceNotificationsMuted.value = false;
    return;
  }

  isLoadingNotificationPreference.value = true;
  notificationPreferenceError.value = null;

  try {
    const response = await api.space.getNotificationPreference(currentSpace.value.id);
    spaceNotificationsMuted.value = response.muted;
  } catch (error) {
    notificationPreferenceError.value =
      error instanceof Error
        ? error.message
        : t("Failed to load notification preference");
  } finally {
    isLoadingNotificationPreference.value = false;
  }
};

const setSpaceNotificationsMuted = async (muted: boolean) => {
  if (!currentSpace.value?.id || isUpdatingNotificationPreference.value) return;

  isUpdatingNotificationPreference.value = true;
  notificationPreferenceError.value = null;

  try {
    const response = await api.space.setNotificationMuted(currentSpace.value.id, muted);
    spaceNotificationsMuted.value = response.muted;
  } catch (error) {
    notificationPreferenceError.value =
      error instanceof Error
        ? error.message
        : t("Failed to update notification preference");
  } finally {
    isUpdatingNotificationPreference.value = false;
  }
};

const handleConnectIntegration = async (provider: OAuthIntegrationProvider) => {
  if (!currentSpace.value?.id) return;
  connectingProvider.value = provider;
  integrationsError.value = null;
  integrationsMessage.value = null;

  try {
    const redirectTo = `${window.location.pathname}${window.location.search}`;
    const response = await api.integrations.connect(currentSpace.value.id, provider, {
      redirectTo,
    });
    window.location.href = response.authorizeUrl;
  } catch (error) {
    integrationsError.value =
      error instanceof Error ? error.message : t("Failed to start OAuth flow");
    connectingProvider.value = null;
  }
};

const handleDisconnectIntegration = async (provider: OAuthIntegrationProvider) => {
  if (!currentSpace.value?.id) return;
  if (!confirm(t("Disconnect {provider}?").replace("{provider}", provider))) return;
  disconnectingProvider.value = provider;
  integrationsError.value = null;
  integrationsMessage.value = null;

  try {
    await api.integrations.disconnect(currentSpace.value.id, provider);
    await loadIntegrations();
  } catch (error) {
    integrationsError.value =
      error instanceof Error ? error.message : t("Failed to disconnect integration");
  } finally {
    disconnectingProvider.value = null;
  }
};

onMounted(() => {
  const savedPreference = getStoredThemePreference();
  themePreference.value = savedPreference;
  applyThemePreference(savedPreference);
  const url = new URL(window.location.href);
  const integrationStatus = url.searchParams.get("status");
  const integrationName = url.searchParams.get("integration");
  const integrationMessage = url.searchParams.get("message");
  if (integrationStatus === "connected" && integrationName) {
    integrationsMessage.value = t("{provider} connected successfully").replace(
      "{provider}",
      integrationName,
    );
  } else if (integrationStatus === "error") {
    integrationsError.value = integrationMessage || t("Integration OAuth failed");
  }

  loadIntegrations();
  loadNotificationPreference();
});

watch(
  () => currentSpace.value?.id,
  () => {
    loadIntegrations();
    loadNotificationPreference();
  },
);
</script>

<template>
  <!-- Header -->
  <div class="px-4 py-3 border-b border-neutral-100 flex items-center gap-2">
    <button
      type="button"
      @click="emit('close')"
      class="inline-flex items-center justify-center w-7 h-7 rounded-md text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
      :aria-label="t('Back to profile menu')"
    >
      <div class="svg-icon w-4 h-4" v-html="chevronLeftLargeIcon" />
    </button>
    <p class="text-base font-medium text-foreground">{{ t("Preferences") }}</p>
  </div>

  <!-- Tabbed settings layout -->
  <SettingsLayout :tabs="tabs" class="w-[620px] max-w-[calc(100vw-2rem)] min-h-[200px]">
    <!-- Appearance tab -->
    <template #appearance>
      <section>
        <div class="mb-3">
          <h2 class="text-size-medium font-semibold text-foreground">
            {{ t("Interface") }}
          </h2>
          <p class="mt-1 text-size-small text-neutral-500">
            {{ t("Choose how Vektor looks on this device.") }}
          </p>
        </div>
        <div class="rounded-lg border border-neutral-200 bg-background p-3">
          <p class="text-size-small font-medium text-foreground">{{ t("Theme") }}</p>
          <fieldset class="mt-3 grid grid-cols-3 gap-3" :aria-label="t('Theme')">
            <button
              v-for="option in themeOptions"
              :key="option.value"
              type="button"
              :aria-pressed="themePreference === option.value"
              @click="setThemePreference(option.value)"
              class="group flex flex-col items-center gap-1.5 rounded-md px-2 py-1 text-size-small font-medium text-neutral-500 transition-colors hover:text-neutral-900"
            >
              <span
                class="flex h-12 w-12 items-center justify-center rounded-full border border-neutral-200 p-0.5 transition-transform group-hover:scale-105"
                :class="themePreference === option.value ? 'ring-2 ring-primary-500 ring-offset-2' : ''"
              >
                <span
                  class="h-full w-full rounded-full"
                  :class="option.swatchClass"
                ></span>
              </span>
              <span>{{ option.label }}</span>
            </button>
          </fieldset>
        </div>
      </section>

      <section class="mt-6">
        <div class="mb-3">
          <h2 class="text-size-medium font-semibold text-foreground">
            {{ t("Collaboration") }}
          </h2>
          <p class="mt-1 text-size-small text-neutral-500">
            {{ t("Personalize how you appear to collaborators.") }}
          </p>
        </div>
        <div class="rounded-lg border border-neutral-200 bg-background p-3">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-size-small font-medium text-foreground">
                {{ t("Cursor color") }}
              </p>
              <p class="mt-0.5 text-label text-neutral-500">
                {{ t("Used for your presence in shared documents and canvases.") }}
              </p>
            </div>
            <button
              v-if="!isAutomaticCursorColor"
              type="button"
              @click="clearCursorColor"
              class="shrink-0 text-label font-medium text-neutral-500 transition-colors hover:text-neutral-900"
            >
              {{ t("Reset to automatic") }}
            </button>
          </div>
          <a-popover-trigger>
            <button
              slot="trigger"
              type="button"
              class="mt-3 flex w-full items-center justify-between gap-3 rounded-md border border-neutral-200 bg-background px-3 py-2 text-size-medium text-foreground transition-colors hover:bg-neutral-50"
              :aria-label="t('Cursor color')"
            >
              <span class="flex items-center gap-2">
                <span
                  class="h-5 w-5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(15,23,42,0.2),0_1px_2px_rgba(15,23,42,0.18)]"
                  :style="{ background: cursorColor }"
                  aria-hidden="true"
                ></span>
                <span>{{ isAutomaticCursorColor ? t("Automatic") : cursorColor }}</span>
              </span>
              <span class="text-label font-medium text-neutral-500"
                >{{ t("Change") }}</span
              >
            </button>
            <a-popover class="group" placements="top-start">
              <div
                class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100"
              >
                <div
                  class="bg-background border border-neutral-100 rounded-lg p-2 origin-bottom-left scale-95 transition-all shadow-large duration-150 group-[&[enabled]]:scale-100"
                >
                  <a-color-picker
                    class="w-[220px]"
                    :value="cursorColor"
                    @change="setCursorColor(($event.target as HTMLElement & { value: string }).value)"
                  ></a-color-picker>
                </div>
              </div>
            </a-popover>
          </a-popover-trigger>
        </div>
      </section>
    </template>

    <template #cosmetics>
      <CosmeticsPanel
        :inventory="cosmeticInventory"
        :loadout="cosmeticLoadout"
        :appearance="cosmeticAppearance"
        :user="currentUser"
        @equip="equipCosmetic"
      />
    </template>

    <!-- Notifications tab -->
    <template #notifications>
      <section>
        <div class="mb-3">
          <p class="text-size-small text-neutral-500">
            {{ t("Manage notifications for the current space.") }}
          </p>
        </div>

        <div
          v-if="notificationPreferenceError"
          class="mb-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-size-small text-red-600"
        >
          {{ notificationPreferenceError }}
        </div>

        <div
          v-if="!currentSpace?.id"
          class="rounded-lg border border-dashed border-neutral-200 p-5 text-center text-size-small text-neutral-500"
        >
          {{ t("Open a space to manage notifications.") }}
        </div>
        <div
          v-else-if="isLoadingNotificationPreference"
          class="rounded-lg border border-neutral-100 p-5 text-center text-size-small text-neutral-500"
        >
          {{ t("Loading...") }}
        </div>
        <div
          v-else
          class="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-background p-3"
        >
          <div>
            <p class="text-size-small font-medium text-foreground">
              {{ t("Mute space notifications") }}
            </p>
            <p class="mt-0.5 text-label text-neutral-500">
              {{ t("Stop email notifications from this space.") }}
            </p>
          </div>
          <SwitchToggle
            :model-value="spaceNotificationsMuted"
            :disabled="isUpdatingNotificationPreference"
            @update:model-value="setSpaceNotificationsMuted"
          />
        </div>
      </section>
    </template>

    <!-- Integrations tab -->
    <template #integrations>
      <section>
        <div class="mb-4">
          <h2 class="text-size-medium font-semibold text-foreground">
            {{ t("Integrations") }}
          </h2>
          <p class="mt-1 text-size-small text-neutral-500">
            {{ t("Connect tools to make them available in this space.") }}
          </p>
          <p class="mt-2 text-label text-neutral-500">
            {{ t("Space:") }}
            <span class="font-medium text-foreground"
              >{{ activeSpaceName || t("None") }}</span
            >
          </p>
        </div>

        <div
          v-if="integrationsError"
          class="mb-3 rounded-md border border-red-200 bg-red-50 p-2.5 text-size-small text-red-600"
        >
          {{ integrationsError }}
        </div>
        <div
          v-if="integrationsMessage"
          class="mb-3 rounded-md border border-green-200 bg-green-50 p-2.5 text-size-small text-green-700"
        >
          {{ integrationsMessage }}
        </div>

        <div
          v-if="!currentSpace?.id"
          class="rounded-lg border border-dashed border-neutral-200 p-5 text-center text-size-small text-neutral-500"
        >
          {{ t("Open a space to manage integrations.") }}
        </div>
        <div
          v-else-if="isLoadingIntegrations"
          class="rounded-lg border border-neutral-100 p-5 text-center text-size-small text-neutral-500"
        >
          {{ t("Loading...") }}
        </div>
        <div v-else class="grid grid-cols-1 gap-3 min-[560px]:grid-cols-2">
          <div
            v-for="card in integrationCards"
            :key="card.provider"
            class="flex min-h-[254px] flex-col rounded-lg border border-neutral-200 bg-background p-4"
          >
            <div class="flex items-start justify-between gap-3">
              <div
                class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-size-large font-semibold text-white"
                :class="card.iconClass"
                aria-hidden="true"
              >
                {{ card.initial }}
              </div>
              <span
                class="inline-flex rounded-full px-2 py-0.5 text-label font-medium"
                :class="
                  card.connection?.connected
                    ? 'bg-green-50 text-green-700'
                    : 'bg-neutral-100 text-neutral-500'
                "
              >
                {{ card.connection?.connected ? t("Connected") : t("Not connected") }}
              </span>
            </div>

            <div class="mt-4">
              <h3 class="text-size-medium font-semibold text-foreground">
                {{ card.connection?.label || card.label }}
              </h3>
              <p class="mt-1 text-size-small leading-5 text-neutral-500">
                {{ card.description }}
              </p>
            </div>

            <div class="mt-3 min-h-10 text-label">
              <p v-if="card.connection?.connected" class="text-neutral-600">
                {{ t("Connected as") }}
                {{ card.connection.externalUsername || card.connection.externalAccountId }}
              </p>
              <p v-else-if="card.connection?.configured === false" class="text-amber-700">
                {{ t("Not configured") }}
              </p>
              <p
                v-else-if="card.connection?.instanceUrl"
                class="truncate text-neutral-500"
              >
                {{ card.connection.instanceUrl }}
              </p>
            </div>

            <div class="mt-auto border-t border-neutral-100 pt-3">
              <button
                v-if="card.connection?.connected"
                type="button"
                :disabled="disconnectingProvider === card.provider"
                @click="handleDisconnectIntegration(card.provider)"
                class="w-full rounded-md border border-red-200 px-3 py-1.5 text-size-small font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                {{ disconnectingProvider === card.provider
                    ? t("Disconnecting…")
                    : t("Disconnect") }}
              </button>
              <Button
                v-else
                :disabled="
                  connectingProvider === card.provider || card.connection?.configured === false
                "
                @click="handleConnectIntegration(card.provider)"
                class="w-full justify-center text-size-small"
              >
                {{ connectingProvider === card.provider ? t("Redirecting…") : t("Connect") }}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </template>
  </SettingsLayout>
</template>
