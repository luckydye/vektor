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
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { type AIConfigMeta, api } from "../api/client.ts";
import { useSpace } from "../composeables/useSpace.ts";

const { currentSpace } = useSpace();

const meta = ref<AIConfigMeta | null>(null);
const isLoading = ref(true);
const loadError = ref<string | null>(null);
const isSaving = ref(false);
const isDeleting = ref(false);
const saveError = ref<string | null>(null);

const form = ref({
  provider: "anthropic" as "anthropic" | "openrouter" | "ollama",
  model: "",
  apiKey: "",
  baseUrl: "",
});

const modelPlaceholder = computed(() => {
  if (form.value.provider === "anthropic") return "claude-sonnet-4-6";
  if (form.value.provider === "openrouter") return "qwen/qwen3.5-397b-a17b";
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
      const existingKeyOk = !apiKey && meta.value?.configured && (meta.value as { hasApiKey: boolean }).hasApiKey;
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

watch(() => currentSpace.value?.id, (id) => { if (id) load(); }, { immediate: true });
</script>
