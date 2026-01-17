<script setup lang="ts">
import "@sv/elements/popover";
import { authClient } from "../composeables/auth-client.js";
import { useUserProfile } from "../composeables/useUserProfile.js";
import Avatar from "./Avatar.vue";

const user = useUserProfile();

const handleLogout = async (e: Event) => {
  try {
    await authClient.signOut();
    e.target?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
    window.location.reload();
  } catch (error) {
    console.error("Logout failed:", error);
  }
};
</script>

<template>
  <a-popover-trigger class="block group relative z-10">
    <button
      slot="trigger"
      type="button"
      class="block rounded-full mx-3 my-2 border-2 border-neutral-300 hover:border-primary-500 transition-colors duration-200 overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 group-[[enabled]]:border-primary-500"
    >
      <Avatar :user="user" />
    </button>

    <a-popover class="group" placements="top-start">
      <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
        <div class="bg-background border border-neutral-100 rounded-lg origin-bottom-left scale-95 transition-all shadow-xl duration-150 group-[[enabled]]:scale-100 min-w-[280px]">
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
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
</template>
