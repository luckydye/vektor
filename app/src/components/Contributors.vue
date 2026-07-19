<script setup lang="ts">
import { computed } from "vue";
import { useActiveCollaboration } from "#composeables/useCollaboration.ts";
import { useContributors } from "#composeables/useContributors.ts";
import "./AvatarElement.ts";
import "@atrium-ui/elements/popover";

interface Props {
  documentId?: string;
  max?: number;
}

interface Collaborator {
  key: string;
  user: {
    name: string;
    email?: string;
    image?: string | null;
  };
  isPresent: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  max: 5,
});

const collaboration = useActiveCollaboration();
const { contributors } = useContributors(props.documentId);

const collaborators = computed(() => {
  const collaboratorsByUser = new Map<string, Collaborator>();

  for (const contributor of contributors.value) {
    collaboratorsByUser.set(contributor.userId, {
      key: contributor.userId,
      user: contributor,
      isPresent: false,
    });
  }

  for (const profile of collaboration.value?.roomPresenceProfiles.value ?? []) {
    const key = profile.user.id || profile.clientId;
    const contributor = collaboratorsByUser.get(key);

    collaboratorsByUser.set(key, {
      key,
      user: contributor
        ? {
            ...contributor.user,
            ...profile.user,
            email: profile.user.email ?? contributor.user.email,
          }
        : profile.user,
      isPresent: true,
    });
  }

  return [...collaboratorsByUser.values()].sort(
    (left, right) => Number(right.isPresent) - Number(left.isPresent),
  );
});

const displayCollaborators = computed(() => collaborators.value.slice(0, props.max));

const remainingCount = computed(() => {
  return Math.max(0, collaborators.value.length - props.max);
});
</script>

<template>
  <a-popover-trigger
    v-if="collaborators.length > 0"
    showdelay="200"
    hidedelay="100"
    class="group relative z-20 block"
  >
    <button
      slot="trigger"
      type="button"
      class="flex items-center"
      data-tooltip="Collaborators"
    >
      <TransitionGroup name="collaborator" tag="span" class="flex items-center">
        <span
          v-for="(collaborator, index) in displayCollaborators"
          :key="collaborator.key"
          class="relative block"
          :class="{ 'z-10': collaborator.isPresent }"
          :style="{
            marginLeft: index > 0 ? `-18px` : '0',
            zIndex: displayCollaborators.length - index,
          }"
          :title="collaborator.user.name"
        >
          <span
            class="block rounded-full transition-shadow duration-200"
            :class="{ 'ring-2 ring-green-500 ring-offset-1 ring-offset-background': collaborator.isPresent }"
          >
            <vektor-avatar
              size="small"
              :user-id="collaborator.key"
              :user="collaborator.user"
            />
          </span>
        </span>
      </TransitionGroup>
      <div
        v-if="remainingCount > 0"
        class="relative flex items-center justify-center rounded-full bg-primary-100 text-label text-primary-400 font-medium border-2 border-background"
        :style="{
          width: `32px`,
          height: `32px`,
          marginLeft: `-18px`,
          zIndex: 0,
        }"
      >
        +{{ remainingCount }}
      </div>
    </button>

    <a-popover class="group" placements="bottom-center">
      <div
        class="w-max opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100 my-3xs"
      >
        <a-popover-arrow>
          <div class="contributors-arrow" />
        </a-popover-arrow>
        <div
          class="bg-neutral-10 border border-neutral-100 rounded-lg p-4xs flex flex-col gap-1 shadow-large min-w-[200px]"
        >
          <div class="text-size-small font-medium text-neutral-600 px-4xs">
            Collaborators
          </div>
          <TransitionGroup
            name="collaborator-row"
            tag="div"
            class="overflow-y-auto max-h-[240px] flex flex-col"
          >
            <div
              v-for="collaborator in collaborators"
              :key="collaborator.key"
              class="flex items-center gap-3xs px-4xs py-4xs rounded-md"
            >
              <div class="relative">
                <vektor-avatar
                  size="small"
                  :user-id="collaborator.key"
                  :user="collaborator.user"
                />
              </div>
              <span class="min-w-0 flex-1 text-interactive text-neutral-950 truncate">
                {{ collaborator.user.name }}
              </span>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </a-popover>
  </a-popover-trigger>
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

.collaborator-move,
.collaborator-row-move,
.collaborator-enter-active,
.collaborator-leave-active,
.collaborator-row-enter-active,
.collaborator-row-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}

.collaborator-enter-from,
.collaborator-leave-to {
  opacity: 0;
  transform: scale(0.75);
}

.collaborator-row-enter-from,
.collaborator-row-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.collaborator-leave-active,
.collaborator-row-leave-active {
  position: absolute;
}

@media (prefers-reduced-motion: reduce) {
  .collaborator-move,
  .collaborator-row-move,
  .collaborator-enter-active,
  .collaborator-leave-active,
  .collaborator-row-enter-active,
  .collaborator-row-leave-active {
    transition: none;
  }
}
</style>
