<script setup lang="ts">
import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { computed, onMounted, ref, watch } from "vue";
import {
  api,
  type OAuthIntegrationConnection,
  type OAuthIntegrationProvider,
} from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { t } from "#utils/lang.ts";
import {
  clearCanvasCursorColor,
  readCanvasCursorColorOverride,
  saveCanvasCursorColor,
} from "#utils/userPreferences.ts";
import { chevronLeftLargeIcon } from "~/src/assets/icons.ts";
import SettingsLayout from "./SettingsLayout.vue";

type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "user-theme-preference";
const themePreference = ref<ThemePreference>("system");
const currentUser = useUserProfile();
// `null` means "automatic" — the presence color follows the user's avatar.
const cursorColorOverride = ref<string | null>(readCanvasCursorColorOverride());
const automaticCursorColor = computed(() =>
  getAvatarColor(currentUser.value?.email || currentUser.value?.id),
);
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
const { currentSpace } = useSpace();

const emit = defineEmits<{
  close: [];
}>();

const tabs = [
  { id: "appearance", label: t("Appearance") },
  { id: "integrations", label: t("Integrations") },
];

const activeSpaceName = computed(() => currentSpace.value?.name || null);

const getIntegrationConnection = (
  provider: OAuthIntegrationProvider,
): OAuthIntegrationConnection | null => {
  return (
    integrationConnections.value.find((connection) => connection.provider === provider) ??
    null
  );
};

const isThemePreference = (value: string | null): value is ThemePreference => {
  return value === "system" || value === "light" || value === "dark";
};

const applyThemePreference = (preference: ThemePreference) => {
  const root = document.documentElement;
  if (preference === "system") {
    root.removeAttribute("data-theme");
    return;
  }
  root.setAttribute("data-theme", preference);
};

const setThemePreference = (preference: ThemePreference) => {
  themePreference.value = preference;
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  applyThemePreference(preference);
};

const handleThemeChange = (event: Event) => {
  const target = event.target as HTMLSelectElement;
  const preference = target.value;
  if (!isThemePreference(preference)) return;
  setThemePreference(preference);
};

const setCursorColor = (color: string) => {
  cursorColorOverride.value = saveCanvasCursorColor(color);
};

const resetCursorColor = () => {
  clearCanvasCursorColor();
  cursorColorOverride.value = null;
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
  const savedPreference = localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemePreference(savedPreference)) {
    themePreference.value = savedPreference;
    applyThemePreference(savedPreference);
  } else {
    setThemePreference("system");
  }
  cursorColorOverride.value = readCanvasCursorColorOverride();

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
});

watch(
  () => currentSpace.value?.id,
  () => {
    loadIntegrations();
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
  <SettingsLayout :tabs="tabs" class="min-h-[200px]">
    <!-- Appearance tab -->
    <template #appearance>
      <section>
        <p class="text-size-small font-medium text-neutral-700 mb-1.5">
          {{ t("Theme") }}
        </p>
        <select
          :value="themePreference"
          @change="handleThemeChange"
          class="w-full px-2.5 py-1.5 rounded-md border border-neutral-100 bg-background text-size-medium text-foreground focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500"
        >
          <option value="system">{{ t("System") }}</option>
          <option value="light">{{ t("Light") }}</option>
          <option value="dark">{{ t("Dark") }}</option>
        </select>
      </section>

      <section class="mt-4">
        <div class="flex items-center justify-between mb-1.5">
          <p class="text-size-small font-medium text-neutral-700">
            {{ t("Cursor color") }}
          </p>
          <button
            v-if="!isAutomaticCursorColor"
            type="button"
            @click="resetCursorColor"
            class="text-label font-medium text-neutral-500 hover:text-neutral-900 transition-colors"
          >
            {{ t("Reset to automatic") }}
          </button>
        </div>
        <a-popover-trigger>
          <button
            slot="trigger"
            type="button"
            class="w-full px-2.5 py-1.5 rounded-md border border-neutral-100 bg-background text-size-medium text-foreground hover:bg-neutral-50 transition-colors flex items-center justify-between gap-3"
            :aria-label="t('Cursor color')"
          >
            <span>{{ isAutomaticCursorColor ? t("Automatic") : cursorColor }}</span>
            <span
              class="w-5 h-5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(15,23,42,0.2),0_1px_2px_rgba(15,23,42,0.18)]"
              :style="{ background: cursorColor }"
              aria-hidden="true"
            ></span>
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
      </section>
    </template>

    <!-- Integrations tab -->
    <template #integrations>
      <section>
        <p class="text-size-small text-neutral-500 mb-2">
          {{ t("Space:") }}
          <span class="font-medium text-foreground"
            >{{ activeSpaceName || t("None") }}</span
          >
        </p>

        <div
          v-if="integrationsError"
          class="mb-2 p-2 bg-red-50 border border-red-200 rounded-sm text-size-small text-red-600"
        >
          {{ integrationsError }}
        </div>
        <div
          v-if="integrationsMessage"
          class="mb-2 p-2 bg-green-50 border border-green-200 rounded-sm text-size-small text-green-700"
        >
          {{ integrationsMessage }}
        </div>

        <div v-if="!currentSpace?.id" class="text-size-small text-neutral-500">
          {{ t("Open a space to manage integrations.") }}
        </div>
        <div v-else-if="isLoadingIntegrations" class="text-size-small text-neutral-500">
          {{ t("Loading...") }}
        </div>
        <div v-else class="space-y-1.5">
          <div
            v-for="provider in integrationProviders"
            :key="provider"
            class="border border-neutral-100 rounded-md p-2"
          >
            <p class="text-size-small font-medium text-foreground leading-tight">
              {{ getIntegrationConnection(provider)?.label || provider }}
            </p>
            <p class="text-label text-neutral-500 mt-0.5">
              <template v-if="getIntegrationConnection(provider)?.connected">
                {{ t("Connected as") }}
                {{ getIntegrationConnection(provider)?.externalUsername ||
                  getIntegrationConnection(provider)?.externalAccountId }}
              </template>
              <template v-else>{{ t("Not connected") }}</template>
            </p>
            <p
              v-if="getIntegrationConnection(provider)?.configured === false"
              class="text-label text-amber-700 mt-0.5"
            >
              {{ t("Missing:") }}
              {{ getIntegrationConnection(provider)?.missingConfig.join(", ") }}
            </p>
            <p
              v-if="getIntegrationConnection(provider)?.instanceUrl"
              class="text-label text-neutral-500 mt-0.5"
            >
              {{ getIntegrationConnection(provider)?.instanceUrl }}
            </p>
            <div class="mt-1.5">
              <button
                v-if="getIntegrationConnection(provider)?.connected"
                type="button"
                :disabled="disconnectingProvider === provider"
                @click="handleDisconnectIntegration(provider)"
                class="px-2 py-0.5 text-label font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50"
              >
                {{ disconnectingProvider === provider
                    ? t("Disconnecting…")
                    : t("Disconnect") }}
              </button>
              <button
                v-else
                type="button"
                :disabled="connectingProvider === provider"
                @click="handleConnectIntegration(provider)"
                class="px-2 py-0.5 text-label font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                {{ connectingProvider === provider ? t("Redirecting…") : t("Connect") }}
              </button>
            </div>
          </div>
        </div>
      </section>
    </template>
  </SettingsLayout>
</template>
