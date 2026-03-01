<script setup lang="ts">
import { ref, onUnmounted, computed } from "vue";
import { Actions } from "../utils/actions.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import { ButtonSecondary } from "~/src/components/index.ts";
import { closeIcon } from "~/src/assets/icons.ts";

const show = ref(false);
const user = useUserProfile();
const copied = ref<string | null>(null);

const serverUrl = computed(() =>
  typeof window !== "undefined" ? window.location.origin : "",
);

async function copy(text: string, key: string) {
  await navigator.clipboard.writeText(text);
  copied.value = key;
  setTimeout(() => {
    copied.value = null;
  }, 2000);
}

Actions.register("caldav:setup", {
  title: "CalDAV Setup",
  description: "Show CalDAV calendar integration setup guide",
  group: "settings",
  run: async () => {
    show.value = true;
  },
});

onUnmounted(() => {
  Actions.unregister("caldav:setup");
});
</script>

<template>
  <div
    v-if="show"
    class="fixed inset-0 z-100 flex items-center justify-center bg-black/50 overflow-hidden"
    @click.self="show = false"
  >
    <div class="bg-background rounded-lg shadow-xl p-s w-full max-w-lg min-w-[320px] flex flex-col gap-xs">
      <div class="flex items-center justify-between">
        <h2 class="text-large font-semibold">CalDAV Setup</h2>
        <ButtonSecondary :icon="closeIcon" @click="show = false" />
      </div>

      <p class="text-small text-neutral-500">
        Connect your calendar app to sync wiki documents as events.
      </p>

      <ol class="flex flex-col gap-xs list-none">
        <li class="flex flex-col gap-4xs">
          <span class="text-small font-medium">1. Create an access token</span>
          <span class="text-small text-neutral-500">
            Open a Space → Settings → Access Tokens, create a token with <em>viewer</em> permission.
          </span>
        </li>

        <li class="flex flex-col gap-4xs">
          <span class="text-small font-medium">2. Add a CalDAV account in your calendar app</span>
          <span class="text-small text-neutral-500">Use these credentials:</span>

          <div class="flex flex-col gap-4xs">
            <div class="flex items-center gap-4xs">
              <span class="text-small text-neutral-400 w-24 shrink-0">Server URL</span>
              <button
                type="button"
                class="flex-1 text-left text-small font-mono bg-neutral-100 dark:bg-neutral-800 rounded px-3xs py-5xs truncate hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
                :title="serverUrl"
                @click="copy(serverUrl, 'url')"
              >{{ serverUrl }}</button>
              <span v-if="copied === 'url'" class="text-extra-small text-green-500 shrink-0">Copied!</span>
            </div>

            <div class="flex items-center gap-4xs">
              <span class="text-small text-neutral-400 w-24 shrink-0">Username</span>
              <button
                type="button"
                class="flex-1 text-left text-small font-mono bg-neutral-100 dark:bg-neutral-800 rounded px-3xs py-5xs truncate hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
                :title="user?.email"
                @click="user?.email && copy(user.email, 'email')"
              >{{ user?.email ?? '—' }}</button>
              <span v-if="copied === 'email'" class="text-extra-small text-green-500 shrink-0">Copied!</span>
            </div>

            <div class="flex items-center gap-4xs">
              <span class="text-small text-neutral-400 w-24 shrink-0">Password</span>
              <span class="flex-1 text-small font-mono bg-neutral-100 dark:bg-neutral-800 rounded px-3xs py-5xs text-neutral-500 italic">
                access token from step 1
              </span>
            </div>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>
