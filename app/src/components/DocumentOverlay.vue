<script setup lang="ts">
/**
 * DocumentOverlay - Opens a document in a modal overlay for quick viewing
 *
 * Usage:
 *   // Via global function (available after component mounts)
 *   window.viewDocument(spaceId, documentId)
 *
 *   // Via custom event
 *   window.dispatchEvent(new CustomEvent("view-document", {
 *     detail: { spaceId: "space-123", documentId: "doc-456" }
 *   }))
 *
 *   // Example from a link click handler
 *   document.querySelector("a[data-doc-id]").addEventListener("click", (e) => {
 *     e.preventDefault();
 *     const docId = e.target.dataset.docId;
 *     const spaceId = document.body.dataset.spaceId;
 *     window.viewDocument?.(spaceId, docId);
 *   });
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { useRouter } from "vue-router";
import {
  closeXIcon,
  commentIcon,
  documentIcon,
  warningTriangleIcon,
} from "~/src/assets/icons.ts";
import type { Comment } from "../api/ApiClient.ts";
import { api } from "../api/client.ts";
import { useComments } from "../composeables/useComments.ts";
import { useSpace } from "../composeables/useSpace.ts";
import docStyles from "../styles/document.css?inline";
import { propertyValueToText } from "../utils/documentProperties.ts";
import { renderMessageMarkdown } from "../utils/messageMarkdown.ts";

interface OverlayState {
  documentId: string;
  spaceId: string;
  slug?: string;
}

const router = useRouter();
const isOpen = ref(false);
const loading = ref(false);
const error = ref<string | null>(null);
const documentData = ref<{
  title: string;
  content: string;
  slug: string;
  updatedAt: Date | string;
} | null>(null);
const currentState = ref<OverlayState | null>(null);
const contentContainer = ref<HTMLElement | null>(null);
const { currentSpaceId, spaces } = useSpace();

const { comments, submitComment } = useComments({
  spaceId: computed(() => currentState.value?.spaceId),
  documentId: computed(() => currentState.value?.documentId),
});

async function openOverlay(spaceId: string, documentId: string) {
  isOpen.value = true;
  loading.value = true;
  error.value = null;
  documentData.value = null;
  currentState.value = { spaceId, documentId };

  try {
    const doc = await api.document.get(spaceId, documentId);
    const title = doc.properties?.title;
    documentData.value = {
      title: title ? propertyValueToText(title) : "Untitled Document",
      content: doc.content || "",
      slug: doc.slug,
      updatedAt: doc.updatedAt,
    };
    currentState.value.slug = doc.slug;
  } catch (err) {
    console.error(err);
    error.value = err instanceof Error ? err.message : "Failed to load document";
  } finally {
    loading.value = false;
  }
}

watchEffect(() => {
  if (!contentContainer.value || !documentData.value) return;

  // Clear existing content
  contentContainer.value.innerHTML = "";

  // Create a document-view element with shadow DOM for proper styling
  const docView = document.createElement("document-view");
  const shadow = docView.attachShadow({ mode: "open" });

  // Add document styles to shadow DOM
  const styleEl = document.createElement("style");
  styleEl.textContent = docStyles;
  shadow.appendChild(styleEl);

  // Add the content
  const contentDiv = document.createElement("div");
  contentDiv.setAttribute("part", "content");
  contentDiv.innerHTML = documentData.value.content;
  shadow.appendChild(contentDiv);

  contentContainer.value.appendChild(docView);
});

function closeOverlay() {
  isOpen.value = false;
  documentData.value = null;
  currentState.value = null;
  error.value = null;
}

function navigateToDocument() {
  if (!currentState.value?.slug) return;

  if (currentState.value.spaceId !== currentSpaceId.value) {
    const targetSpace = spaces.value?.find(
      (space) => space.id === currentState.value?.spaceId,
    );
    if (targetSpace) {
      window.location.href = `/${targetSpace.slug}/doc/${currentState.value.slug}`;
      return;
    }
  }

  router.push(`/doc/${currentState.value.slug}`);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && isOpen.value) {
    closeOverlay();
  }
}

function handleBackdropClick(event: MouseEvent) {
  if (event.target === event.currentTarget) {
    closeOverlay();
  }
}

// Event handler for custom event (by document ID)
function handleViewDocumentEvent(event: Event) {
  const customEvent = event as CustomEvent<{ spaceId: string; documentId: string }>;
  openOverlay(customEvent.detail.spaceId, customEvent.detail.documentId);
}

onMounted(() => {
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("view-document", handleViewDocumentEvent);
});

onUnmounted(() => {
  document.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("view-document", handleViewDocumentEvent);
});

// Prevent body scroll when overlay is open
watch(isOpen, (open) => {
  document.body.style.overflow = open ? "hidden" : "";
});

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase())
    .slice(0, 2)
    .join("");
}

function formatCommentTime(date: Date | string): string {
  const commentDate = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - commentDate.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return commentDate.toLocaleDateString();
}
</script>

<template>
  <Teleport to="body">
    <!-- Backdrop -->
    <Transition
      enter-active-class="transition-opacity duration-200"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-200"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="isOpen"
        class="fixed inset-0 z-100 bg-black/30"
        @click="closeOverlay"
      />
    </Transition>

    <!-- Slide-in Panel -->
    <Transition
      enter-active-class="transition-transform duration-300 ease-out"
      enter-from-class="translate-y-full lg:translate-y-0 lg:translate-x-full"
      enter-to-class="translate-y-0 lg:translate-x-0"
      leave-active-class="transition-transform duration-200 ease-in"
      leave-from-class="translate-y-0 lg:translate-x-0"
      leave-to-class="translate-y-full lg:translate-y-0 lg:translate-x-full"
    >
      <a-blur
        v-if="isOpen"
        @exit="closeOverlay"
        enabled="isOpen"
        class="fixed overflow-hidden top-6 left-0 right-0 bottom-0 z-100 lg:top-0 lg:right-0 lg:bottom-0 lg:left-auto w-full lg:max-w-[50vw] min-w-[400px]"
      >
            <drawer-track class="pointer-events-none h-full">
                <div class="flex-none h-[calc(100vh-169px)] w-full pointer-events-none lg:hidden"></div>

                <div class="flex-1 bg-background max-h-screen h-full pointer-events-auto flex flex-col">
                    <!-- Header -->
                    <div class="flex items-center justify-between px-6 py-4 border-b border-neutral-100 shrink-0">
                      <div class="flex items-center gap-3 min-w-0">
                        <div class="svg-icon w-5 h-5 text-neutral-400 shrink-0" v-html="documentIcon" />
                        <h2 v-if="documentData" class="text-size-title font-semibold text-foreground truncate">
                          {{ documentData.title }}
                        </h2>
                        <div v-else-if="loading" class="h-6 w-48 bg-neutral-200 rounded-sm animate-pulse" />
                      </div>

                      <div class="flex items-center gap-2 shrink-0">
                        <button
                          v-if="documentData"
                          @click="navigateToDocument"
                          class="px-3 py-1.5 text-size-medium font-medium text-neutral-600 hover:text-foreground hover:bg-neutral-100 rounded-sm transition-colors"
                          title="Open full document"
                        >
                          Open
                        </button>
                        <button
                          @click="closeOverlay"
                          class="p-1.5 text-neutral-400 hover:text-foreground hover:bg-neutral-100 rounded-sm transition-colors"
                          title="Close (Esc)"
                        >
                          <div class="svg-icon w-5 h-5" v-html="closeXIcon" />
                        </button>
                      </div>
                    </div>

                    <!-- Content -->
                    <div class="flex-1 overflow-y-auto" data-scroll-container>
                      <!-- Loading state -->
                      <div v-if="loading" class="p-6 space-y-4">
                        <div class="h-4 w-3/4 bg-neutral-200 rounded-sm animate-pulse" />
                        <div class="h-4 w-full bg-neutral-200 rounded-sm animate-pulse" />
                        <div class="h-4 w-5/6 bg-neutral-200 rounded-sm animate-pulse" />
                        <div class="h-4 w-2/3 bg-neutral-200 rounded-sm animate-pulse" />
                      </div>

                      <!-- Error state -->
                      <div v-else-if="error" class="p-6 text-center">
                        <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4">
                          <div class="svg-icon w-6 h-6 text-red-600" v-html="warningTriangleIcon" />
                        </div>
                        <p class="text-neutral-600">{{ error }}</p>
                        <button
                          @click="closeOverlay"
                          class="mt-4 px-4 py-2 text-size-medium font-medium text-neutral-600 hover:text-foreground border border-neutral-100 rounded-sm hover:bg-neutral-50 transition-colors"
                        >
                          Close
                        </button>
                      </div>

                      <!-- Document content (rendered into shadow DOM) -->
                      <div v-else-if="documentData" ref="contentContainer" class="p-6" />

                      <!-- Comments Thread -->
                      <div v-if="documentData" class="border-t border-neutral-100 bg-neutral-50">
                        <!-- Comments Header -->
                        <div class="px-6 py-4 flex items-center gap-2">
                          <div class="svg-icon w-4 h-4 text-neutral-600" v-html="commentIcon" />
                          <h3 class="text-size-medium font-semibold text-foreground">
                            Comments ({{ comments.length }})
                          </h3>
                        </div>

                        <!-- Comments List -->
                        <div class="px-6 pb-6 space-y-6">
                          <div v-if="comments.length === 0" class="py-8 text-center">
                            <p class="text-size-medium text-neutral-500">No comments yet. Be the first to comment!</p>
                          </div>

                          <div v-for="comment in comments" :key="comment.id" class="flex gap-3">
                            <!-- Avatar -->
                            <div class="w-8 h-8 rounded-full bg-linear-to-br from-blue-400 to-blue-600 flex items-center justify-center text-size-small font-semibold text-white shrink-0">
                              {{ getInitials(comment.createdByUser?.name || comment.createdBy) }}
                            </div>

                            <!-- Comment Content -->
                            <div class="flex-1 min-w-0">
                              <div class="flex items-baseline gap-2">
                                <span class="text-size-medium font-semibold text-foreground">
                                  {{ comment.createdByUser?.name || comment.createdBy }}
                                </span>
                                <span class="text-size-small text-neutral-500">
                                  {{ formatCommentTime(comment.createdAt) }}
                                </span>
                              </div>

                              <div
                                class="mt-1 text-size-medium text-neutral-700 leading-relaxed markdown-comment"
                                v-html="renderMessageMarkdown(comment.content)"
                              />
                            </div>
                          </div>
                        </div>

                        <!-- Add Comment Input -->
                        <div class="px-6 py-4 border-t border-neutral-100 bg-white">
                          <div class="flex gap-3">
                            <div class="w-8 h-8 rounded-full bg-linear-to-br from-purple-400 to-purple-600 flex items-center justify-center text-size-small font-semibold text-white shrink-0">
                              You
                            </div>
                            <div class="flex-1">
                              <textarea
                                placeholder="Add a comment..."
                                class="w-full px-3 py-2 text-size-medium border border-neutral-100 rounded-sm bg-white text-foreground placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                                rows="2"
                              />
                              <div class="mt-2 flex justify-end gap-2">
                                <button class="px-3 py-1.5 text-size-medium font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-sm transition-colors">
                                  Comment
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                </div>

            </drawer-track>
      </a-blur>
    </Transition>
  </Teleport>
</template>

<style scoped>
.markdown-comment :deep(ul) { list-style: disc; padding-left: 1.25rem; }
.markdown-comment :deep(ol) { list-style: decimal; padding-left: 1.25rem; }
.markdown-comment :deep(strong) { font-weight: 600; }
.markdown-comment :deep(em) { font-style: italic; }
.markdown-comment :deep(a) { color: var(--color-primary-600); text-decoration: underline; }
</style>
