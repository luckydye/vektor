<script setup lang="ts">
import { activityIcon, addIcon, deleteEntryIcon, editEntryIcon } from "#assets/icons.ts";
import type { ChatSession } from "#composeables/useChatSessions.ts";
import { formatAbsoluteDate } from "#utils/datetime.ts";

defineProps<{
  sessions: ChatSession[];
  currentSessionId: string | null;
  /** Picker replaces the transcript; the toolbar shows when it is closed. */
  showPicker: boolean;
  isGenerating: boolean;
  getSessionStatus: (session: ChatSession) => string;
}>();

const emit = defineEmits<{
  "update:showPicker": [value: boolean];
  "new-chat": [];
  resume: [session: ChatSession];
  remove: [session: ChatSession];
}>();
</script>

<template>
  <!-- Session toolbar -->
  <div
    v-if="!showPicker"
    class="flex shrink-0 items-center gap-3 border-b border-neutral-100 bg-neutral-10 px-3 py-4"
  >
    <button
      v-if="sessions.length > 0"
      type="button"
      @click="emit('update:showPicker', true)"
      class="flex items-center gap-1.5 text-size-small text-neutral-500 hover:text-neutral-700 transition-colors"
      title="Recent conversations"
    >
      <div class="svg-icon w-3.5 h-3.5" v-html="activityIcon" />
      History
    </button>
    <div class="flex-1" />
    <button
      type="button"
      @click="emit('new-chat')"
      :disabled="isGenerating"
      class="flex items-center gap-1 text-size-small text-primary-600 hover:text-primary-700 font-medium transition-colors"
      title="New chat"
    >
      <div class="svg-icon w-3.5 h-3.5" v-html="editEntryIcon" />
      <span>New chat</span>
    </button>
  </div>

  <!-- Sessions picker -->
  <div v-if="showPicker" class="flex-1 overflow-y-auto px-3 py-4">
    <div class="flex items-center justify-between mb-3">
      <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wide">
        Recent conversations
      </p>
      <button
        type="button"
        @click="emit('new-chat')"
        class="flex items-center gap-1 text-size-small text-primary-600 hover:text-primary-700 font-medium transition-colors"
      >
        <div class="svg-icon w-3.5 h-3.5" v-html="addIcon" />
        New chat
      </button>
    </div>
    <div class="space-y-0.5">
      <!-- biome-ignore lint/a11y/noStaticElementInteractions: The row preserves the surrounding list layout and is activated by Vue click handling. -->
      <!-- biome-ignore lint/a11y/useKeyWithClickEvents: Session navigation is handled by the surrounding keyboard command interface. -->
      <div
        v-for="session in sessions"
        :key="session.id"
        class="group flex items-center gap-2.5 px-3 py-2.5 rounded-lg hover:bg-neutral-100 cursor-pointer transition-colors"
        @click="emit('resume', session)"
      >
        <!-- Status dot -->
        <div class="shrink-0 mt-0.5">
          <span
            v-if="getSessionStatus(session) === 'generating'"
            class="block w-2 h-2 rounded-full bg-primary-500 animate-pulse"
          />
          <span
            v-else-if="getSessionStatus(session) === 'awaiting'"
            class="block w-2 h-2 rounded-full bg-amber-400"
          />
          <span v-else class="block w-2 h-2 rounded-full bg-neutral-200" />
        </div>

        <div class="flex-1 min-w-0">
          <p class="text-size-medium text-neutral-800 truncate">
            {{ session.title }}
          </p>
          <p class="text-size-small mt-0.5">
            <template v-if="getSessionStatus(session) === 'generating'">
              <span class="text-primary-500 font-medium">Generating response…</span>
            </template>
            <template v-else-if="getSessionStatus(session) === 'awaiting'">
              <span class="text-amber-500 font-medium">Awaiting response</span>
            </template>
            <template v-else>
              <span class="text-neutral-400"
                >{{ formatAbsoluteDate(session.updatedAt) }}</span
              >
            </template>
          </p>
        </div>

        <button
          type="button"
          @click.stop="emit('remove', session)"
          class="opacity-0 group-hover:opacity-100 p-1 text-neutral-400 hover:text-red-500 transition-all shrink-0"
          title="Delete"
        >
          <div class="svg-icon w-3.5 h-3.5" v-html="deleteEntryIcon" />
        </button>
      </div>
    </div>
  </div>
</template>
