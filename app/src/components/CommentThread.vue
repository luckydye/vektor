<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useMembers } from "#composeables/useMembers.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import { renderMessageMarkdown } from "#utils/messageMarkdown.ts";
import { cancelIcon, confirmationIcon, deleteEntryIcon } from "~/src/assets/icons.ts";
import "./AvatarElement.ts";
import ButtonGhost from "./ButtonGhost.vue";
import MessageInput from "./MessageInput.vue";

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
  spaceId: string;
  documentId: string;
  comments: Comment[];
  activeReference?: string | null;
  isSubmitting?: boolean;
  isDeletingComment?: boolean;
}>();

const emit = defineEmits<{
  (e: "clear-reference"): void;
  (e: "submit", payload: { content: string; reference: string | null }): void;
  (e: "delete", commentId: string): void;
  (e: "resolve"): void;
  (e: "close"): void;
}>();

const { members } = useMembers();
const currentUser = useUserProfile();

const newCommentContent = ref("");
const commentListRef = ref<HTMLElement | null>(null);

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
</script>

<template>
  <div
    class="flex flex-col h-full bg-background rounded-lg shadow-xl border border-neutral-100 w-80 max-h-[600px]"
  >
    <!-- Header -->
    <div
      class="flex items-center justify-between p-3 border-b border-neutral-100 bg-neutral-50/80 rounded-t-lg backdrop-blur-sm"
    >
      <div class="flex items-center gap-2">
        <h3 class="font-semibold text-neutral-800 text-size-medium">Thread</h3>
        <span
          v-if="comments.length > 0"
          class="text-[10px] font-medium text-neutral-500 bg-neutral-200/50 px-1.5 py-0.5 rounded-full"
        >
          {{ comments.length }}
        </span>
      </div>
      <div class="flex items-center gap-1">
        <ButtonGhost
          v-if="comments.length > 0"
          @click="emit('resolve')"
          class="p-1 text-neutral-400 hover:text-green-600 w-6 h-6"
          title="Resolve thread"
        >
          <div class="svg-icon w-4 h-4" v-html="confirmationIcon" />
        </ButtonGhost>
        <ButtonGhost
          @click="emit('close')"
          class="p-1 -mr-1 text-neutral-400 hover:text-neutral-700 w-6 h-6"
        >
          <div class="svg-icon w-4 h-4" v-html="cancelIcon" />
        </ButtonGhost>
      </div>
    </div>

    <!-- Comments List -->
    <div ref="commentListRef" class="flex-1 p-3 overflow-y-auto space-y-4">
      <div
        v-if="comments.length === 0"
        class="flex flex-col items-center justify-center h-24 text-center text-neutral-400"
      >
        <p class="text-size-medium font-medium text-neutral-500">No comments yet</p>
        <p class="text-size-small opacity-75">Start the conversation!</p>
      </div>

      <div v-for="comment in comments" :key="comment.id" class="flex gap-2 group">
        <vektor-avatar size="24" :user-id="comment.createdBy" class="shrink-0 mt-0.5" />

        <div class="flex-1 min-w-0">
          <div class="flex items-baseline gap-2 mb-0.5">
            <span class="text-size-small font-semibold text-neutral-900 truncate">
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
              <div class="svg-icon w-3 h-3" v-html="deleteEntryIcon" />
            </ButtonGhost>
          </div>

          <div
            class="comment-markdown text-size-medium text-neutral-700 leading-relaxed break-words"
            v-html="renderMessageMarkdown(comment.content)"
          />
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="p-5xs">
      <div class="px-3 py-2 bg-neutral-50 border border-neutral-100 rounded-lg">
        <MessageInput
          v-model="newCommentContent"
          mentions
          :space-id="spaceId"
          :document-id="documentId"
          placeholder="Reply..."
          :rows="2"
          submit-key="ctrl+enter"
          :disabled="isSubmitting || !newCommentContent.trim()"
          :loading="isSubmitting"
          @submit="handleSubmit"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(p) {
  margin: 0.2rem 0;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(ul) {
  list-style: disc;
  padding-left: 1.1rem;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(ol) {
  list-style: decimal;
  padding-left: 1.1rem;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(strong) {
  font-weight: 600;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(em) {
  font-style: italic;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(a) {
  color: var(--color-primary-600);
  text-decoration: underline;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(document-mention),
.comment-markdown :deep(a[href*="/doc/"]) {
  background: var(--color-neutral-50);
  border: 1px solid var(--color-neutral-200);
  border-radius: 0.375rem;
  color: var(--color-primary-700);
  cursor: default;
  font-weight: 500;
  padding: 0.0625rem 0.3125rem;
  text-decoration: none;
  white-space: nowrap;
}
/* biome-ignore lint/correctness/noUnknownPseudoClass: Vue scoped-style selector is handled by the Vue compiler. */
.comment-markdown :deep(document-mention:hover),
.comment-markdown :deep(a[href*="/doc/"]:hover) {
  background: var(--color-primary-50);
  border-color: var(--color-primary-200);
}
</style>
