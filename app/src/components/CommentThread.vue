<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from "vue";
import Avatar from "./Avatar.vue";
import ButtonPrimary from "./ButtonPrimary.vue";
import ButtonGhost from "./ButtonGhost.vue";
import Icon from "./Icon.vue";
import { useMembers } from "../composeables/useMembers.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";

export interface Comment {
  id: string;
  content: string;
  createdAt: string;
  createdBy: string;
  reference?: string;
  parentId?: string | null;
  resourceType?: string;
  resourceId?: string;
}

const props = defineProps<{
  comments: Comment[];
  activeReference?: string | null;
  isSubmitting?: boolean;
  isDeletingComment?: boolean;
}>();

const emit = defineEmits<{
  (e: "clear-reference"): void;
  (e: "submit", payload: { content: string; reference: string | null }): void;
  (e: "delete", commentId: string): void;
  (e: "close"): void;
}>();

const { members } = useMembers();
const currentUser = useUserProfile();

const newCommentContent = ref("");
const commentListRef = ref<HTMLElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const getUserName = (userId: string): string => {
  const member = members.value.find((m) => m.userId === userId);
  return member?.user?.name || member?.user?.email || userId;
};

function getRelativeTime(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function handleSubmit() {
  if (!newCommentContent.value.trim()) return;

  emit("submit", {
    content: newCommentContent.value,
    reference: props.activeReference || null,
  });

  newCommentContent.value = "";
}

function handleDeleteComment(commentId: string) {
  if (confirm("Are you sure you want to delete this comment?")) {
    emit("delete", commentId);
  }
}

watch(
  () => props.comments.length,
  () => {
    nextTick(() => {
      if (commentListRef.value) {
        commentListRef.value.scrollTop = commentListRef.value.scrollHeight;
      }
    });
  },
);

onMounted(() => {
  if (textareaRef.value) {
    textareaRef.value.focus();
  }
});
</script>

<template>
  <div class="flex flex-col h-full bg-background rounded-lg shadow-xl border border-neutral-100 w-80 max-h-[600px]">
    <!-- Header -->
    <div class="flex items-center justify-between p-3 border-b border-neutral-100 bg-neutral-50/80 rounded-t-lg backdrop-blur-sm">
      <div class="flex items-center gap-2">
        <h3 class="font-semibold text-neutral-800 text-sm">Thread</h3>
        <span v-if="comments.length > 0" class="text-[10px] font-medium text-neutral-500 bg-neutral-200/50 px-1.5 py-0.5 rounded-full">
          {{ comments.length }}
        </span>
      </div>
      <ButtonGhost @click="emit('close')" class="p-1 -mr-1 text-neutral-400 hover:text-neutral-700 w-6 h-6">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </ButtonGhost>
    </div>

    <!-- Comments List -->
    <div ref="commentListRef" class="flex-1 p-3 overflow-y-auto space-y-4">
      <div v-if="comments.length === 0" class="flex flex-col items-center justify-center h-24 text-center text-neutral-400">
        <p class="text-sm font-medium text-neutral-500">No comments yet</p>
        <p class="text-xs opacity-75">Start the conversation!</p>
      </div>

      <div v-for="comment in comments" :key="comment.id" class="flex gap-2 group">
        <Avatar :id="comment.createdBy" class="shrink-0 w-6 h-6 mt-0.5" />

        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2 mb-0.5">
            <span class="text-xs font-semibold text-neutral-900 truncate">
              {{ getUserName(comment.createdBy) }}
            </span>
            <span class="text-[10px] text-neutral-400 whitespace-nowrap">
              {{ getRelativeTime(comment.createdAt) }}
            </span>
            <ButtonGhost
              v-if="currentUser?.id === comment.createdBy"
              @click="handleDeleteComment(comment.id)"
              :disabled="isDeletingComment"
              class="ml-auto p-0.5 text-neutral-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity w-5 h-5"
              title="Delete comment"
            >
              <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </ButtonGhost>
          </div>

          <div class="text-sm text-neutral-700 leading-relaxed whitespace-pre-wrap break-words">
            {{ comment.content }}
          </div>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="p-5xs">
      <div class="relative">
        <textarea
          ref="textareaRef"
          v-model="newCommentContent"
          rows="2"
          class="block w-full p-2 pr-20 text-sm bg-neutral-50 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-primary-500 outline-none resize-none transition-shadow placeholder:text-neutral-400"
          placeholder="Reply..."
          @keydown.enter.ctrl.prevent="handleSubmit"
        ></textarea>

        <div class="absolute right-2 top-2">
          <ButtonPrimary
            @click="handleSubmit"
            :disabled="isSubmitting || !newCommentContent.trim()"
            class="text-xs font-medium"
            title="Send"
          >
            <span v-if="isSubmitting">...</span>
            <Icon v-else name="send" />
            <span class="sr-only">Send</span>
          </ButtonPrimary>
        </div>
      </div>
    </div>
  </div>
</template>