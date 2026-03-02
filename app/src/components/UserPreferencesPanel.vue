<script setup lang="ts">
import { onMounted, ref } from "vue";

type ThemePreference = "system" | "light" | "dark" | "github";

const THEME_STORAGE_KEY = "user-theme-preference";
const themePreference = ref<ThemePreference>("system");

const emit = defineEmits<{
  close: [];
}>();

const isThemePreference = (value: string | null): value is ThemePreference => {
  return value === "system" || value === "light" || value === "dark" || value === "github";
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

onMounted(() => {
  const savedPreference = localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemePreference(savedPreference)) {
    themePreference.value = savedPreference;
    applyThemePreference(savedPreference);
    return;
  }
  setThemePreference("system");
});
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
      <option value="github">GitHub</option>
    </select>
  </div>
</template>
