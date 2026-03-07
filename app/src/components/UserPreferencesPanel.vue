<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, type OAuthIntegrationConnection, type OAuthIntegrationProvider } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";

type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "user-theme-preference";
const themePreference = ref<ThemePreference>("system");
const integrationProviders: OAuthIntegrationProvider[] = ["gitlab", "youtrack"];
const integrationConnections = ref<OAuthIntegrationConnection[]>([]);
const isLoadingIntegrations = ref(false);
const integrationsError = ref<string | null>(null);
const integrationsMessage = ref<string | null>(null);
const connectingProvider = ref<OAuthIntegrationProvider | null>(null);
const disconnectingProvider = ref<OAuthIntegrationProvider | null>(null);
const instanceUrls = ref<Record<OAuthIntegrationProvider, string>>({
  gitlab: "",
  youtrack: "",
});
const { currentSpace } = useSpace();

const emit = defineEmits<{
  close: [];
}>();

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
    for (const provider of integrationProviders) {
      const connected = response.connections?.find((c) => c.provider === provider);
      instanceUrls.value[provider] = connected?.instanceUrl ?? "";
    }
  } catch (error) {
    integrationsError.value =
      error instanceof Error ? error.message : "Failed to load integrations";
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
    const instanceUrl = instanceUrls.value[provider].trim() || undefined;
    const response = await api.integrations.connect(currentSpace.value.id, provider, {
      redirectTo,
      instanceUrl,
    });
    window.location.href = response.authorizeUrl;
  } catch (error) {
    integrationsError.value =
      error instanceof Error ? error.message : "Failed to start OAuth flow";
    connectingProvider.value = null;
  }
};

const handleDisconnectIntegration = async (provider: OAuthIntegrationProvider) => {
  if (!currentSpace.value?.id) return;
  if (!confirm(`Disconnect ${provider}?`)) return;
  disconnectingProvider.value = provider;
  integrationsError.value = null;
  integrationsMessage.value = null;

  try {
    await api.integrations.disconnect(currentSpace.value.id, provider);
    await loadIntegrations();
  } catch (error) {
    integrationsError.value =
      error instanceof Error ? error.message : "Failed to disconnect integration";
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

  const url = new URL(window.location.href);
  const integrationStatus = url.searchParams.get("status");
  const integrationName = url.searchParams.get("integration");
  const integrationMessage = url.searchParams.get("message");
  if (integrationStatus === "connected" && integrationName) {
    integrationsMessage.value = `${integrationName} connected successfully`;
  } else if (integrationStatus === "error") {
    integrationsError.value = integrationMessage || "Integration OAuth failed";
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
  <div class="p-4 border-b border-neutral-100 flex items-center gap-2">
    <button
      type="button"
      @click="emit('close')"
      class="inline-flex items-center justify-center w-7 h-7 rounded-md text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 transition-colors"
      aria-label="Back to profile menu"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
      </svg>
    </button>
    <p class="text-base font-medium text-foreground">Preferences</p>
  </div>

  <div class="p-4">
    <label for="theme-preference" class="block text-label text-neutral-600 mb-2">
      Theme
    </label>
    <select
      id="theme-preference"
      :value="themePreference"
      @change="handleThemeChange"
      class="w-full px-3 py-2 rounded-md border border-neutral-100 bg-background text-base text-foreground focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500"
    >
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </div>

  <div class="px-4 pb-4">
    <div class="h-px bg-neutral-100 my-2"></div>
    <p class="text-base font-medium text-foreground mt-4 mb-2">Integrations</p>
    <p class="text-label text-neutral-600 mb-3">
      Connect your accounts for space:
      <span class="font-medium text-foreground">{{ activeSpaceName || "No active space" }}</span>
    </p>

    <div
      v-if="integrationsError"
      class="mb-3 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-600"
    >
      {{ integrationsError }}
    </div>
    <div
      v-if="integrationsMessage"
      class="mb-3 p-2 bg-green-50 border border-green-200 rounded text-sm text-green-700"
    >
      {{ integrationsMessage }}
    </div>

    <div v-if="!currentSpace?.id" class="text-sm text-neutral-500">
      Open a space to manage integrations.
    </div>
    <div v-else-if="isLoadingIntegrations" class="text-sm text-neutral-500">
      Loading integrations...
    </div>
    <div v-else class="space-y-2">
      <div
        v-for="provider in integrationProviders"
        :key="provider"
        class="border border-neutral-100 rounded-md p-2.5"
      >
        <div class="items-start justify-between">
          <div>
            <p class="text-sm font-medium text-foreground">
              {{ getIntegrationConnection(provider)?.label || provider }}
            </p>
            <p class="text-xs text-neutral-500 mt-0.5">
              <template v-if="getIntegrationConnection(provider)?.connected">
                Connected as
                {{
                  getIntegrationConnection(provider)?.externalUsername ||
                  getIntegrationConnection(provider)?.externalAccountId
                }}
              </template>
              <template v-else>
                Not connected
              </template>
            </p>
            <p
              v-if="getIntegrationConnection(provider)?.configured === false"
              class="text-xs text-amber-700 mt-1"
            >
              Missing config: {{ getIntegrationConnection(provider)?.missingConfig.join(", ") }}
            </p>
            <label class="block text-xs text-neutral-500 mt-2">
              Instance URL (optional)
            </label>
            <input
              v-model="instanceUrls[provider]"
              type="url"
              placeholder="https://your-instance.example"
              class="mt-1 w-full px-2 py-1 rounded border border-neutral-100 bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500"
            />
            <p
              v-if="getIntegrationConnection(provider)?.instanceUrl"
              class="text-xs text-neutral-500 mt-1"
            >
              Connected instance: {{ getIntegrationConnection(provider)?.instanceUrl }}
            </p>
          </div>
          <div class="mt-4"> 
            <button
              v-if="getIntegrationConnection(provider)?.connected"
              type="button"
              :disabled="disconnectingProvider === provider"
              @click="handleDisconnectIntegration(provider)"
              class="px-2.5 py-1 text-xs font-medium text-red-600 border border-red-200 rounded-md hover:bg-red-50 disabled:opacity-50"
            >
              {{ disconnectingProvider === provider ? "Disconnecting..." : "Disconnect" }}
            </button>
            <button
              v-else
              type="button"
              :disabled="connectingProvider === provider"
              @click="handleConnectIntegration(provider)"
              class="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {{ connectingProvider === provider ? "Redirecting..." : "Connect" }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
