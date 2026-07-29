<script setup lang="ts">
import {
  preferencesIcon,
  sendFeedbackIcon,
  signOutIcon,
  sourceCodeIcon,
} from "~/src/assets/icons.ts";
import "./AvatarElement.ts";
import UserPreferencesPanel from "./UserPreferencesPanel.vue";
import "@atrium-ui/elements/popover";
import { computed, onMounted, ref } from "vue";
import { authClient } from "#composeables/auth-client.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { t } from "#utils/lang.ts";
import { applyThemePreference, getStoredThemePreference } from "#utils/themePreference.ts";

const profileUser = useUserProfile();
const { appearance } = useCosmetics();
applyThemePreference(getStoredThemePreference());
const isMounted = ref(false);
onMounted(() => {
  isMounted.value = true;
});
const user = computed(() =>
  isMounted.value && profileUser.value
    ? { ...profileUser.value, appearance: appearance.value }
    : undefined,
);
const isPreferencesOpen = ref(false);
const isPreferencesLeaving = ref(false);
const isPreferencesViewActive = computed(
  () => isPreferencesOpen.value || isPreferencesLeaving.value,
);

const openPreferences = () => {
  isPreferencesLeaving.value = false;
  isPreferencesOpen.value = true;
};

const closePreferences = () => {
  if (!isPreferencesOpen.value) return;
  isPreferencesLeaving.value = true;
  isPreferencesOpen.value = false;
};

const handlePreferencesLeave = () => {
  isPreferencesLeaving.value = false;
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
      class="block rounded-full mx-1.5 my-2 overflow-visible focus-ring"
    >
      <vektor-avatar :user="user" />
    </button>

    <a-popover class="group" placements="top-start" @exit="handlePopoverExit">
      <div
        class="overflow-hidden rounded-lg bg-background opacity-0 shadow-xl transition-[width,opacity] duration-150 ease-out group-[[enabled]]:opacity-100"
        :class="
          isPreferencesViewActive
            ? 'w-[620px] max-w-[calc(100vw-2rem)]'
            : 'w-[300px] max-w-[calc(100vw-2rem)]'
        "
      >
        <div
          class="border border-neutral-100 rounded-lg origin-bottom-left scale-95 transition-all duration-150 group-[[enabled]]:scale-100"
          :class="
            isPreferencesViewActive
              ? 'w-[620px] max-w-[calc(100vw-2rem)]'
              : 'w-[300px] max-w-[calc(100vw-2rem)]'
          "
        >
          <template v-if="!isPreferencesViewActive">
            <!-- User Info -->
            <div class="p-4 border-b border-neutral-100">
              <div class="flex items-center gap-3">
                <div class="flex-1 min-w-0">
                  <p class="text-size-medium font-medium text-foreground truncate">
                    {{ user?.name || t("Anonymous User") }}
                  </p>
                  <p class="text-size-normal text-neutral-600 truncate">
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
                class="w-full text-left px-3xs py-3xs text-size-small text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="preferencesIcon" />
                <span class="leading-none font-medium">{{ t("Preferences") }}</span>
              </button>
              <a
                href="mailto:t.havlicek@s-v.de"
                class="w-full text-left px-3xs py-3xs text-size-small text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="sendFeedbackIcon" />
                <span class="leading-none font-medium">{{ t("Send feedback") }}</span>
              </a>
              <a
                href="https://github.com/luckydye/vektor"
                class="w-full text-left px-3xs py-3xs text-size-small text-foreground hover:bg-neutral-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="sourceCodeIcon" />
                <span class="leading-none font-medium">{{ t("Source") }}</span>
              </a>
              <button
                type="button"
                @click="handleLogout"
                class="w-full text-left px-3xs py-3xs text-size-small text-red-600 hover:bg-red-50 rounded-lg transition-colors duration-200 flex items-center gap-2.5"
              >
                <div class="svg-icon w-4 h-4" v-html="signOutIcon" />
                <span class="leading-none font-medium">{{ t("Sign Out") }}</span>
              </button>
            </div>
          </template>

          <Transition name="preferences-panel" @after-leave="handlePreferencesLeave">
            <div
              v-if="isPreferencesOpen"
              class="w-[620px] max-w-[calc(100vw-2rem)]"
            >
              <UserPreferencesPanel @close="closePreferences" />
            </div>
          </Transition>
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
</template>

<style>
.preferences-panel-enter-active,
.preferences-panel-leave-active {
  transition:
    opacity 160ms var(--emphasized-curve, ease-out),
    transform 160ms var(--emphasized-curve, ease-out);
}

.preferences-panel-enter-from {
  opacity: 0;
  transform: translateX(14px);
}

.preferences-panel-leave-to {
  opacity: 0;
  transform: translateX(14px);
}

@media (prefers-reduced-motion: reduce) {
  .preferences-panel-enter-active,
  .preferences-panel-leave-active {
    transition: none;
  }
}

</style>
