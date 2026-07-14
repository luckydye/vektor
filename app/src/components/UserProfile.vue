<script setup lang="ts">
import { archiveBoxIcon, cogIcon, mailIcon, signOutIcon } from "~/src/assets/icons.ts";
import Avatar from "./Avatar.vue";
import UserPreferencesPanel from "./UserPreferencesPanel.vue";
import "@atrium-ui/elements/popover";
import { computed, onMounted, ref } from "vue";
import { authClient } from "#composeables/auth-client.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { t } from "#utils/lang.ts";

const profileUser = useUserProfile();
const isMounted = ref(false);
onMounted(() => {
  isMounted.value = true;
});
const user = computed(() => (isMounted.value ? profileUser.value : undefined));
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
      class="block rounded-full mx-1.5 my-2 border-2 border-neutral-100 hover:border-primary-500 transition-colors duration-200 overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 group-[[enabled]]:border-primary-500"
    >
      <Avatar :user="user" />
    </button>

    <a-popover class="group" placements="top-start" @exit="handlePopoverExit">
      <div
        class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100"
        :class="isPreferencesOpen ? 'max-w-sm' : 'max-w-[300px]'"
      >
        <div
          class="bg-background border border-neutral-100 rounded-lg origin-bottom-left scale-95 transition-all shadow-xl duration-150 group-[[enabled]]:scale-100"
          :class="isPreferencesOpen ? 'min-w-[340px]' : 'min-w-[280px]'"
        >
          <template v-if="!isPreferencesOpen">
            <!-- User Info -->
            <div class="p-4 border-b border-neutral-100">
              <div class="flex items-center gap-3">
                <div class="flex-1 min-w-0">
                  <p class="text-base font-medium text-foreground truncate">
                    {{ user?.name || t("Anonymous User") }}
                  </p>
                  <p class="text-label text-neutral-600 truncate">
                    {{ user?.email || t("No email") }}
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
                <div class="svg-icon w-4 h-4" v-html="cogIcon" />
                <span class="leading-none font-medium">{{ t("Preferences") }}</span>
              </button>
              <a
                href="mailto:t.havlicek@s-v.de"
                class="w-full text-left px-3xs py-3xs text-interactive text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="mailIcon" />
                <span class="leading-none font-medium">{{ t("Send feedback") }}</span>
              </a>
              <a
                href="https://github.com/luckydye/vektor"
                class="w-full text-left px-3xs py-3xs text-interactive text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="archiveBoxIcon" />
                <span class="leading-none font-medium">{{ t("Source") }}</span>
              </a>
              <button
                type="button"
                @click="handleLogout"
                class="w-full text-left px-3xs py-3xs text-interactive text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="signOutIcon" />
                <span class="leading-none font-medium">{{ t("Sign Out") }}</span>
              </button>
            </div>
          </template>

          <UserPreferencesPanel v-else @close="closePreferences" />
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
</template>
