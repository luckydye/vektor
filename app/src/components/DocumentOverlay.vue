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
import { computed, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { useRouter } from "vue-router";
import type { Comment } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { useComments } from "#composeables/useComments.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { propertyValueToText } from "#documents/properties.ts";
import docStyles from "#editor/css/document.css?inline";
import { formatRelativeTime } from "#utils/datetime.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import "./AvatarElement.ts";
import {
  cancelIcon,
  commentIcon,
  documentIcon,
  warningTriangleIcon,
} from "~/src/assets/icons.ts";

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

const { comments } = useComments({
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

function formatCommentTime(date: Date | string): string {
  return formatRelativeTime(date, { style: "narrow", maxDays: 7 });
}
</script>

<template>
  <Teleport to="body">
    <!-- Backdrop -->
    <!-- biome-ignore lint/a11y/noStaticElementInteractions: The handler forwards pointer events within this Vue component; the element is not a standalone control. -->
    <!-- biome-ignore lint/a11y/useKeyWithClickEvents: This Vue event handler is supplemental to the component's keyboard interaction model. -->
    <div
      :hidden="!isOpen"
      class="overlay-fade fixed inset-0 z-100 bg-black/30"
      @click="closeOverlay"
    />

    <!-- Slide-in Panel -->
    <a-blur
      :hidden="!isOpen"
      :enabled="isOpen"
      @exit="closeOverlay"
      class="overlay-slide fixed overflow-hidden top-6 left-0 right-0 bottom-0 z-100 lg:top-0 lg:right-0 lg:bottom-0 lg:left-auto w-full lg:max-w-[50vw] min-w-[400px]"
    >
      <drawer-track class="pointer-events-none h-full">
        <div
          class="flex-none h-[calc(100vh-169px)] w-full pointer-events-none lg:hidden"
        ></div>

        <div
          class="flex-1 bg-background max-h-screen h-full pointer-events-auto flex flex-col"
        >
          <!-- Header -->
          <div
            class="flex items-center justify-between px-6 py-4 border-b border-neutral-100 shrink-0"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div
                class="svg-icon w-5 h-5 text-neutral-400 shrink-0"
                v-html="documentIcon"
              />
              <h2
                v-if="documentData"
                class="text-size-title font-semibold text-foreground truncate"
              >
                {{ documentData.title }}
              </h2>
              <div
                v-else-if="loading"
                class="h-6 w-48 bg-neutral-200 rounded-sm animate-pulse"
              />
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                v-if="documentData"
                @click="navigateToDocument"
                class="px-3 py-1.5 text-size-medium font-medium text-neutral-600 hover:text-foreground hover:bg-neutral-100 rounded-sm transition-colors"
                title="Open full document"
              >
                Open
              </button>
              <button
                type="button"
                @click="closeOverlay"
                class="p-1.5 text-neutral-400 hover:text-foreground hover:bg-neutral-100 rounded-sm transition-colors"
                title="Close (Esc)"
              >
                <div class="svg-icon w-5 h-5" v-html="cancelIcon" />
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
              <div
                class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4"
              >
                <div class="svg-icon w-6 h-6 text-red-600" v-html="warningTriangleIcon" />
              </div>
              <p class="text-neutral-600">{{ error }}</p>
              <button
                type="button"
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
                  <p class="text-size-medium text-neutral-500">No comments yet.</p>
                </div>

                <div v-for="comment in comments" :key="comment.id" class="flex gap-3">
                  <!-- Avatar -->
                  <vektor-avatar
                    size="small"
                    :user-id="comment.createdBy"
                    :user="comment.createdByUser"
                  />

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
                      class="mt-1 text-size-medium text-neutral-700 leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_strong]:font-semibold [&_em]:italic [&_a]:text-primary-600 [&_a]:underline"
                      v-html="renderMessageMarkdown(comment.content)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </drawer-track>
    </a-blur>
  </Teleport>
</template>
