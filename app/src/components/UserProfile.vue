<script setup lang="ts">
import "@sv/elements/popover";
import { onMounted, ref } from "vue";
import { authClient } from "../composeables/auth-client.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import Avatar from "./Avatar.vue";
import UserPreferencesPanel from "./UserPreferencesPanel.vue";

const user = useUserProfile();
const isPreferencesOpen = ref(false);

const openPreferences = () => {
  isPreferencesOpen.value = true;
};

const closePreferences = () => {
  isPreferencesOpen.value = false;
};

const handlePopoverExit = () => {
  closePreferences();
};

const handleLogout = async (e: Event) => {
  try {
    await authClient.signOut();
    e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
    window.location.reload();
  } catch (error) {
    console.error("Logout failed:", error);
  }
};

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("integration") && params.get("status")) {
    isPreferencesOpen.value = true;
  }
});
</script>

<template>
  <a-popover-trigger class="block group relative z-10">
    <button
      slot="trigger"
      type="button"
      class="block rounded-full mx-3 my-2 border-2 border-neutral-100 hover:border-primary-500 transition-colors duration-200 overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 group-[[enabled]]:border-primary-500"
    >
      <Avatar :user="user" />
    </button>

    <a-popover class="group" placements="top-start" @exit="handlePopoverExit">
      <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
        <div class="bg-background border border-neutral-100 rounded-lg origin-bottom-left scale-95 transition-all shadow-xl duration-150 group-[[enabled]]:scale-100 min-w-[280px]">
          <template v-if="!isPreferencesOpen">
            <!-- User Info -->
            <div class="p-4 border-b border-neutral-100">
              <div class="flex items-center gap-3">
                <div class="flex-1 min-w-0">
                  <p class="text-base font-medium text-foreground truncate">
                    {{ user?.name || 'Anonymous User' }}
                  </p>
                  <p class="text-label text-neutral-600 truncate">
                    {{ user?.email || 'No email' }}
                  </p>
                </div>
              </div>
            </div>

            <!-- Actions -->
            <div class="p-[4px]">
              <button
                type="button"
                @click="openPreferences"
                class="w-full text-left px-3xs py-3xs text-interactive text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.54-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.757.426 1.757 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.54-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.757-2.924 1.757-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.54.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.757-.426-1.757-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.54.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                <span class="leading-none font-medium">Preferences</span>
              </button>
              <a
                href="mailto:t.havlicek@s-v.de"
                class="w-full text-left px-3xs py-3xs text-interactive text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
                <span class="leading-none font-medium">Send feedback</span>
              </a>
              <button
                type="button"
                @click="handleLogout"
                class="w-full text-left px-3xs py-3xs text-interactive text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="2"
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                <span class="leading-none font-medium">Sign Out</span>
              </button>
            </div>
          </template>

          <UserPreferencesPanel v-else @close="closePreferences" />
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
</template>
