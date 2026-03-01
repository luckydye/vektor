<script setup lang="ts">
import { computed, toRef } from "vue";
import { useUser } from "../composeables/useUsers.ts";

interface Props {
  user?: {
    name?: string;
    email?: string;
    image?: string | null;
  };
  id?: string;
  size?: "small" | "medium" | "large" | number;
}

const props = withDefaults(defineProps<Props>(), {
  size: "medium",
});

const { user: fetchedUser } = useUser(toRef(() => (props.user ? undefined : props.id)));

const resolvedUser = computed(() => {
  if (props.user) {
    return props.user;
  }
  return fetchedUser.value;
});

const sizeMap = {
  small: 24,
  medium: 36,
  large: 48,
};

const avatarSize = computed(() => {
  if (typeof props.size === "number") {
    return props.size;
  }
  return sizeMap[props.size];
});

const userInitials = computed(() => {
  if (!resolvedUser.value?.name) return "?";

  const names = resolvedUser.value.name.split(" ");
  if (names.length >= 2) {
    return `${names[0][0]}${names[names.length - 1][0]}`.toUpperCase();
  }
  return resolvedUser.value.name[0]?.toUpperCase() || "?";
});
</script>

<template>
  <div class="rounded-full bg-neutral-200 border-1 border-neutral-100 overflow-hidden flex-none" :style="{
    width: `${avatarSize}px`,
    height: `${avatarSize}px`
  }">
    <img
        v-if="resolvedUser?.image"
        :src="resolvedUser.image"
        :alt="resolvedUser.name || 'User profile'"
        class="object-cover"
    />
    <div
        v-else
        class="bg-linear-to-br from-primary-500 to-purple-600 flex items-center justify-center text-white font-semibold text-lg w-full h-full"
    >
        {{ userInitials }}
    </div>
  </div>
</template>