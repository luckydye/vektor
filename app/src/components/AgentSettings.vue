<template>
  <div>
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-size-medium font-semibold text-neutral-900">AI Provider</h2>
    </div>

    <div v-if="loadError" class="mb-4 p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
      {{ loadError }}
    </div>

    <div v-if="isLoading" class="text-size-medium text-neutral-500 py-4">Loading…</div>

    <div v-else>
      <!-- Current config status -->
      <div v-if="meta?.configured" class="mb-5 p-3 bg-green-50 border border-green-200 rounded-md flex items-center justify-between gap-4">
        <div class="text-size-medium text-green-800">
          <span class="font-medium">{{ meta.provider }}</span>
          <span class="mx-1.5 text-green-400">·</span>
          <code class="font-mono text-size-small">{{ meta.model }}</code>
          <template v-if="meta.baseUrl">
            <span class="mx-1.5 text-green-400">·</span>
            <span class="text-size-small text-green-700">{{ meta.baseUrl }}</span>
          </template>
        </div>
        <button
          @click="handleDelete"
          :disabled="isDeleting"
          class="shrink-0 text-size-small text-red-600 hover:text-red-800 disabled:opacity-50"
        >{{ isDeleting ? 'Removing…' : 'Remove' }}</button>
      </div>
      <div v-else class="mb-5 p-3 bg-neutral-50 border border-neutral-200 rounded-md text-size-medium text-neutral-500">
        No AI provider configured. The agent will not work until one is set.
      </div>

      <!-- Configuration form -->
      <form @submit.prevent="handleSave" class="space-y-4">
        <div>
          <label class="block text-size-small font-medium text-neutral-700 mb-1">Provider</label>
          <select
            v-model="form.provider"
            class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="anthropic">Anthropic</option>
            <option value="openrouter">OpenRouter</option>
            <option value="opencode-zen">opencode Zen</option>
            <option value="ollama">Ollama</option>
          </select>
        </div>

        <div>
          <label class="block text-size-small font-medium text-neutral-700 mb-1">Model</label>
          <input
            v-model="form.model"
            type="text"
            required
            :placeholder="modelPlaceholder"
            class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>

        <div v-if="form.provider === 'ollama'">
          <label class="block text-size-small font-medium text-neutral-700 mb-1">Base URL</label>
          <input
            v-model="form.baseUrl"
            type="url"
            required
            placeholder="http://127.0.0.1:11434"
            class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>

        <div v-else>
          <label class="block text-size-small font-medium text-neutral-700 mb-1">
            API Key
            <span v-if="meta?.configured && meta.hasApiKey" class="ml-1 text-neutral-400 font-normal">(leave blank to keep existing)</span>
          </label>
          <input
            v-model="form.apiKey"
            type="password"
            :required="!(meta?.configured && meta.hasApiKey)"
            :placeholder="meta?.configured && meta.hasApiKey ? '••••••••' : 'sk-…'"
            class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>

        <div v-if="saveError" class="p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
          {{ saveError }}
        </div>

        <div class="flex justify-end">
          <button
            type="submit"
            :disabled="isSaving"
            class="px-4 py-1.5 text-size-medium font-medium text-neutral-10 bg-neutral-900 rounded-md hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-500 disabled:opacity-50 transition-colors"
          >{{ isSaving ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    </div>

    <!-- Web Search -->
    <div class="mt-10 pt-6 border-t border-neutral-200">
      <h2 class="text-size-medium font-semibold text-neutral-900 mb-1">Web Search</h2>
      <p class="text-size-small text-neutral-500 mb-4">
        Endpoint the agent's <code class="font-mono">websearch</code> command queries. The search term is appended as a <code class="font-mono">q</code> parameter, and the JSON response is read as <code class="font-mono">results[]</code> with <code class="font-mono">title</code>, <code class="font-mono">url</code>, and <code class="font-mono">content</code> (falling back to <code class="font-mono">snippet</code>/<code class="font-mono">description</code>). Works with a self-hosted SearXNG instance.
      </p>

      <div v-if="searchMeta?.configured" class="mb-4 p-3 bg-green-50 border border-green-200 rounded-md flex items-center justify-between gap-4">
        <span class="text-size-small text-green-700 font-mono break-all">{{ searchMeta.url }}</span>
        <button
          @click="handleDeleteSearch"
          :disabled="isDeletingSearch"
          class="shrink-0 text-size-small text-red-600 hover:text-red-800 disabled:opacity-50"
        >{{ isDeletingSearch ? 'Removing…' : 'Remove' }}</button>
      </div>
      <div v-else class="mb-4 p-3 bg-neutral-50 border border-neutral-200 rounded-md text-size-medium text-neutral-500">
        No search endpoint configured. The <code class="font-mono">websearch</code> command will be unavailable until one is set.
      </div>

      <form @submit.prevent="handleSaveSearch" class="space-y-4">
        <div>
          <label class="block text-size-small font-medium text-neutral-700 mb-1">Search endpoint URL</label>
          <input
            v-model="searchForm.url"
            type="url"
            required
            placeholder="https://searxng.example.com/search?format=json"
            class="w-full px-3 py-1.5 text-size-medium border border-neutral-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
          />
        </div>

        <div v-if="searchError" class="p-2 bg-red-50 border border-red-200 rounded-sm text-size-medium text-red-600">
          {{ searchError }}
        </div>

        <div class="flex justify-end">
          <button
            type="submit"
            :disabled="isSavingSearch"
            class="px-4 py-1.5 text-size-medium font-medium text-neutral-10 bg-neutral-900 rounded-md hover:bg-neutral-700 focus:outline-none focus:ring-2 focus:ring-neutral-500 disabled:opacity-50 transition-colors"
          >{{ isSavingSearch ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { type AIConfigMeta, api, type SearchConfigMeta } from "#api/client.ts";
import { useSpace } from "#composeables/useSpace.ts";

const { currentSpace } = useSpace();

const meta = ref<AIConfigMeta | null>(null);
const isLoading = ref(true);
const loadError = ref<string | null>(null);
const isSaving = ref(false);
const isDeleting = ref(false);
const saveError = ref<string | null>(null);

const form = ref({
  provider: "anthropic" as "anthropic" | "openrouter" | "opencode-zen" | "ollama",
  model: "",
  apiKey: "",
  baseUrl: "",
});

const modelPlaceholder = computed(() => {
  if (form.value.provider === "anthropic") return "claude-sonnet-4-6";
  if (form.value.provider === "openrouter") return "qwen/qwen3.5-397b-a17b";
  if (form.value.provider === "opencode-zen") return "claude-sonnet-4-6";
  return "qwen3:latest";
});

async function load() {
  const spaceId = currentSpace.value?.id;
  if (!spaceId) return;
  isLoading.value = true;
  loadError.value = null;
  try {
    const res = await api.agentSettings.get(spaceId);
    meta.value = res.aiProvider;
    if (res.aiProvider.configured) {
      form.value.provider = res.aiProvider.provider as typeof form.value.provider;
      form.value.model = res.aiProvider.model;
      form.value.baseUrl = res.aiProvider.baseUrl ?? "";
      form.value.apiKey = "";
    }
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : "Failed to load AI config";
  } finally {
    isLoading.value = false;
  }
}

async function handleSave() {
  const spaceId = currentSpace.value?.id;
  if (!spaceId) return;
  isSaving.value = true;
  saveError.value = null;
  try {
    const { provider, model, apiKey, baseUrl } = form.value;
    let body: Parameters<typeof api.agentSettings.put>[1];
    if (provider === "ollama") {
      body = { provider: "ollama", model, baseUrl };
    } else {
      // Keep existing key if blank and one already exists
      const existingKeyOk =
        !apiKey &&
        meta.value?.configured &&
        (meta.value as { hasApiKey: boolean }).hasApiKey;
      if (!existingKeyOk && !apiKey) {
        saveError.value = "API key is required";
        return;
      }
      if (existingKeyOk) {
        // Re-fetch the existing key isn't possible; send a re-save of current config without changing the key.
        // The backend requires apiKey for these providers — fetch current meta and instruct user to re-enter.
        saveError.value = "Enter the API key to save changes.";
        return;
      }
      body = { provider, model, apiKey };
    }
    const res = await api.agentSettings.put(spaceId, body);
    meta.value = res.aiProvider;
    form.value.apiKey = "";
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : "Failed to save AI config";
  } finally {
    isSaving.value = false;
  }
}

async function handleDelete() {
  const spaceId = currentSpace.value?.id;
  if (!spaceId) return;
  isDeleting.value = true;
  try {
    await api.agentSettings.delete(spaceId);
    meta.value = { configured: false };
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : "Failed to remove AI config";
  } finally {
    isDeleting.value = false;
  }
}

// Web search endpoint config
const searchMeta = ref<SearchConfigMeta | null>(null);
const searchForm = ref({ url: "" });
const isSavingSearch = ref(false);
const isDeletingSearch = ref(false);
const searchError = ref<string | null>(null);

async function loadSearch() {
  const spaceId = currentSpace.value?.id;
  if (!spaceId) return;
  try {
    const res = await api.agentSettings.getSearch(spaceId);
    searchMeta.value = res.search;
    searchForm.value.url = res.search.configured ? res.search.url : "";
  } catch (err) {
    searchError.value =
      err instanceof Error ? err.message : "Failed to load search config";
  }
}

async function handleSaveSearch() {
  const spaceId = currentSpace.value?.id;
  if (!spaceId) return;
  isSavingSearch.value = true;
  searchError.value = null;
  try {
    const res = await api.agentSettings.putSearch(spaceId, {
      url: searchForm.value.url.trim(),
    });
    searchMeta.value = res.search;
  } catch (err) {
    searchError.value =
      err instanceof Error ? err.message : "Failed to save search config";
  } finally {
    isSavingSearch.value = false;
  }
}

async function handleDeleteSearch() {
  const spaceId = currentSpace.value?.id;
  if (!spaceId) return;
  isDeletingSearch.value = true;
  searchError.value = null;
  try {
    await api.agentSettings.deleteSearch(spaceId);
    searchMeta.value = { configured: false };
    searchForm.value.url = "";
  } catch (err) {
    searchError.value =
      err instanceof Error ? err.message : "Failed to remove search config";
  } finally {
    isDeletingSearch.value = false;
  }
}

watch(
  () => currentSpace.value?.id,
  (id) => {
    if (id) {
      load();
      loadSearch();
    }
  },
  { immediate: true },
);
</script>
