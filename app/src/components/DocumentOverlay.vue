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
import { ref, onMounted, onUnmounted, watch, nextTick, computed, watchEffect } from "vue";
import { api } from "../api/client.ts";
import { useDocuments } from "../composeables/useDocuments.ts";
import docStyles from "../styles/document.css?inline";
import { useComments } from "../composeables/useComments.ts";
import type { Comment } from "../api/ApiClient.ts";

interface OverlayState {
  documentId: string;
  spaceId: string;
  slug?: string;
}

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

// Use cached documents for efficient slug lookup
const { documents } = useDocuments();
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
    documentData.value = {
      title: doc.properties?.title || "Untitled Document",
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

  // Get space slug from current URL
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const targetSpaceSlug = pathParts[0];

  if (targetSpaceSlug && currentState.value.slug) {
    window.location.href = `/${targetSpaceSlug}/doc/${currentState.value.slug}`;
  }
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

// Event handler for slug-based viewing (from document-view shadow DOM clicks)
function handleViewDocumentBySlugEvent(event: Event) {
  const customEvent = event as CustomEvent<{ spaceId: string; docSlug: string }>;
  fetchDocumentBySlug(customEvent.detail.spaceId, customEvent.detail.docSlug);
}

async function fetchDocumentBySlug(spaceId: string, slug: string) {
  isOpen.value = true;
  loading.value = true;
  error.value = null;
  documentData.value = null;
  currentState.value = { spaceId, documentId: "" };

  try {
    // First check cached documents from useDocuments
    let doc = documents.value.find((d) => d.slug === slug);

    // If not in cache, fetch fresh list
    if (!doc) {
      const freshDocs = await api.documents.get(spaceId);
      doc = freshDocs.documents?.find((d) => d.slug === slug);
    }

    if (!doc) {
      throw new Error("Document not found");
    }

    // Now fetch the full document with content
    const fullDoc = await api.document.get(spaceId, doc.id);
    documentData.value = {
      title: fullDoc.properties?.title || "Untitled Document",
      content: fullDoc.content || "",
      slug: fullDoc.slug,
      updatedAt: fullDoc.updatedAt,
    };
    currentState.value = { spaceId, documentId: doc.id, slug: fullDoc.slug };
  } catch (err) {
    console.error(err);
    error.value = err instanceof Error ? err.message : "Failed to load document";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  document.addEventListener("keydown", handleKeydown);
  window.addEventListener("view-document", handleViewDocumentEvent);
  window.addEventListener("view-document-by-slug", handleViewDocumentBySlugEvent);
});

onUnmounted(() => {
  document.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("view-document", handleViewDocumentEvent);
  window.removeEventListener("view-document-by-slug", handleViewDocumentBySlugEvent);
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
                        <svg class="w-5 h-5 text-neutral-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <h2 v-if="documentData" class="text-lg font-semibold text-foreground truncate">
                          {{ documentData.title }}
                        </h2>
                        <div v-else-if="loading" class="h-6 w-48 bg-neutral-200 rounded animate-pulse" />
                      </div>

                      <div class="flex items-center gap-2 shrink-0">
                        <button
                          v-if="documentData"
                          @click="navigateToDocument"
                          class="px-3 py-1.5 text-sm font-medium text-neutral-600 hover:text-foreground hover:bg-neutral-100 rounded transition-colors"
                          title="Open full document"
                        >
                          Open
                        </button>
                        <button
                          @click="closeOverlay"
                          class="p-1.5 text-neutral-400 hover:text-foreground hover:bg-neutral-100 rounded transition-colors"
                          title="Close (Esc)"
                        >
                          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    <!-- Content -->
                    <div class="flex-1 overflow-y-auto" data-scroll-container>
                      <!-- Loading state -->
                      <div v-if="loading" class="p-6 space-y-4">
                        <div class="h-4 w-3/4 bg-neutral-200 rounded animate-pulse" />
                        <div class="h-4 w-full bg-neutral-200 rounded animate-pulse" />
                        <div class="h-4 w-5/6 bg-neutral-200 rounded animate-pulse" />
                        <div class="h-4 w-2/3 bg-neutral-200 rounded animate-pulse" />
                      </div>

                      <!-- Error state -->
                      <div v-else-if="error" class="p-6 text-center">
                        <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4">
                          <svg class="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                          </svg>
                        </div>
                        <p class="text-neutral-600">{{ error }}</p>
                        <button
                          @click="closeOverlay"
                          class="mt-4 px-4 py-2 text-sm font-medium text-neutral-600 hover:text-foreground border border-neutral-100 rounded hover:bg-neutral-50 transition-colors"
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
                          <svg class="w-4 h-4 text-neutral-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2h-2.586a1 1 0 00-.707.293l-4.414 4.414z" />
                          </svg>
                          <h3 class="text-sm font-semibold text-foreground">
                            Comments ({{ comments.length }})
                          </h3>
                        </div>

                        <!-- Comments List -->
                        <div class="px-6 pb-6 space-y-6">
                          <div v-if="comments.length === 0" class="py-8 text-center">
                            <p class="text-sm text-neutral-500">No comments yet. Be the first to comment!</p>
                          </div>

                          <div v-for="comment in comments" :key="comment.id" class="flex gap-3">
                            <!-- Avatar -->
                            <div class="w-8 h-8 rounded-full bg-linear-to-br from-blue-400 to-blue-600 flex items-center justify-center text-xs font-semibold text-white shrink-0">
                              {{ getInitials(comment.createdByUser?.name || comment.createdBy) }}
                            </div>

                            <!-- Comment Content -->
                            <div class="flex-1 min-w-0">
                              <div class="flex items-baseline gap-2">
                                <span class="text-sm font-semibold text-foreground">
                                  {{ comment.createdByUser?.name || comment.createdBy }}
                                </span>
                                <span class="text-xs text-neutral-500">
                                  {{ formatCommentTime(comment.createdAt) }}
                                </span>
                              </div>

                              <p class="mt-1 text-sm text-neutral-700 leading-relaxed">
                                {{ comment.content }}
                              </p>
                            </div>
                          </div>
                        </div>

                        <!-- Add Comment Input -->
                        <div class="px-6 py-4 border-t border-neutral-100 bg-white">
                          <div class="flex gap-3">
                            <div class="w-8 h-8 rounded-full bg-linear-to-br from-purple-400 to-purple-600 flex items-center justify-center text-xs font-semibold text-white shrink-0">
                              You
                            </div>
                            <div class="flex-1">
                              <textarea
                                placeholder="Add a comment..."
                                class="w-full px-3 py-2 text-sm border border-neutral-100 rounded bg-white text-foreground placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
                                rows="2"
                              />
                              <div class="mt-2 flex justify-end gap-2">
                                <button class="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors">
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
