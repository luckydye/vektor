<script setup lang="ts">
import { computed } from "vue";
import { useActiveCollaboration } from "#composeables/useCollaboration.ts";
import { useContributors } from "#composeables/useContributors.ts";
import Avatar from "./Avatar.vue";
import "@atrium-ui/elements/popover";

interface Props {
  documentId?: string;
  max?: number;
}

const props = withDefaults(defineProps<Props>(), {
  max: 5,
});

const collaboration = useActiveCollaboration();
const { contributors, isLoading, error } = useContributors(props.documentId);

const displayContributors = computed(() => {
  return contributors.value.slice(0, props.max);
});

const remainingCount = computed(() => {
  return Math.max(0, contributors.value.length - props.max);
});

const presentUsers = computed(() => {
  const users = new Map(
    (collaboration.value?.roomPresenceProfiles.value ?? []).map((profile) => {
      const key = profile.user.id || profile.clientId;
      return [key, { key, user: profile.user }] as const;
    }),
  );
  return [...users.values()];
});

const displayPresentUsers = computed(() => {
  return presentUsers.value.slice(0, props.max);
});

const remainingPresentCount = computed(() => {
  return Math.max(0, presentUsers.value.length - props.max);
});
</script>

<template>
  <div class="flex items-center gap-3xs">
    <a-popover-trigger
      v-if="presentUsers.length > 0"
      showdelay="200"
      hidedelay="100"
      class="group relative z-20"
    >
      <button
        slot="trigger"
        type="button"
        class="flex items-center"
        data-tooltip="Present now"
      >
        <div
          v-for="(presentUser, index) in displayPresentUsers"
          :key="presentUser.key"
          class="relative"
          :style="{
            marginLeft: index > 0 ? `-18px` : '0',
            zIndex: displayPresentUsers.length - index,
          }"
          :title="presentUser.user.name"
        >
          <Avatar size="small" :user="presentUser.user" />
          <span
            class="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-background bg-green-500"
            aria-hidden="true"
          />
        </div>
        <div
          v-if="remainingPresentCount > 0"
          class="relative flex items-center justify-center rounded-full bg-green-100 text-label font-medium text-green-700 border-2 border-background"
          :style="{
            width: `32px`,
            height: `32px`,
            marginLeft: `-18px`,
            zIndex: 0,
          }"
        >
          +{{ remainingPresentCount }}
        </div>
      </button>

      <a-popover class="group" placements="bottom-center">
        <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100 my-3xs">
          <a-popover-arrow>
            <div class="contributors-arrow" />
          </a-popover-arrow>
          <div class="bg-neutral-10 border border-neutral-100 rounded-lg p-4xs flex flex-col gap-1 shadow-large min-w-[180px]">
            <div class="text-size-small font-medium text-neutral-600 px-4xs">Present now</div>
            <div class="overflow-y-auto max-h-[240px] flex flex-col">
              <div
                v-for="presentUser in presentUsers"
                :key="presentUser.key"
                class="flex items-center gap-3xs px-4xs py-4xs rounded-md"
              >
                <div class="relative">
                  <Avatar size="small" :user="presentUser.user" />
                  <span
                    class="absolute right-0 bottom-0 h-2.5 w-2.5 rounded-full border-2 border-background bg-green-500"
                    aria-hidden="true"
                  />
                </div>
                <span class="text-interactive text-neutral-950 truncate">{{ presentUser.user.name }}</span>
              </div>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>

    <a-popover-trigger v-if="!isLoading && !error && contributors.length > 0" showdelay="200" hidedelay="100" class="group relative z-10">
      <button slot="trigger" type="button" class="flex items-center" data-tooltip="Authors">
        <div v-for="(contributor, index) in displayContributors" :key="contributor.id" class="relative" :style="{
          marginLeft: index > 0 ? `-18px` : '0',
          zIndex: displayContributors.length - index
        }" :title="contributor.name">
          <Avatar size="small" :user="contributor" />
        </div>
        <div v-if="remainingCount > 0"
          class="relative flex items-center justify-center rounded-full bg-primary-100 text-label text-primary-400 font-medium border-2 border-background"
          :style="{
            width: `32px`,
            height: `32px`,
            marginLeft: `-18px`,
            zIndex: 0
          }">
          +{{ remainingCount }}
        </div>
      </button>

      <a-popover class="group" placements="bottom-center">
        <div class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100 my-3xs">
          <a-popover-arrow>
            <div class="contributors-arrow" />
          </a-popover-arrow>
          <div class="bg-neutral-10 border border-neutral-100 rounded-lg p-4xs flex flex-col gap-1 shadow-large min-w-[180px]">
            <div class="text-size-small font-medium text-neutral-600 px-4xs">Authors</div>
            <div class="overflow-y-auto max-h-[240px] flex flex-col">
            <div v-for="contributor in contributors" :key="contributor.id" class="flex items-center gap-3xs px-4xs py-4xs rounded-md">
              <Avatar size="small" :user="contributor" />
              <span class="text-interactive text-neutral-950 truncate">{{ contributor.name }}</span>
            </div>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  </div>
</template>

<style>
a-popover-arrow {
  z-index: 1;
}

.contributors-arrow {
  margin: -4px;
  width: 10px;
  height: 10px;
  background: var(--color-neutral-10);
  border-left: 1px solid var(--color-neutral-100);
  border-top: 1px solid var(--color-neutral-100);
  transform: rotate(45deg);
}

[data-placement="top"] .contributors-arrow {
  transform: rotate(225deg);
}
</style>
