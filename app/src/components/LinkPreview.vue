<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import type { LinkMetadata } from "../pages/api/v1/url-metadata.ts";

const activePreview = ref<{
  url: string;
  x: number;
  y: number;
  data: LinkMetadata | null;
  loading: boolean;
  error: boolean;
} | null>(null);

let hideTimeout: ReturnType<typeof setTimeout> | null = null;
let showTimeout: ReturnType<typeof setTimeout> | null = null;

const metadataCache = new Map<string, LinkMetadata>();

async function fetchMetadata(url: string): Promise<LinkMetadata | null> {
  const cached = metadataCache.get(url);
  if (cached) return cached;

  const response = await fetch(`/api/v1/url-metadata?url=${encodeURIComponent(url)}`);
  if (!response.ok) {
    throw new Error("Failed to fetch metadata");
  }

  const data = await response.json();
  metadataCache.set(url, data);
  return data;
}

function isValidLink(element: HTMLElement): element is HTMLAnchorElement {
  if (element.tagName !== "A") return false;
  const anchor = element as HTMLAnchorElement;
  const href = anchor.getAttribute("href");
  if (!href) return false;

  if (href.startsWith("http://") || href.startsWith("https://")) {
    return true;
  }

  if (href.startsWith("/") && !href.startsWith("//")) {
    if (href.startsWith("/api/") || href.startsWith("/_")) return false;
    return true;
  }

  return false;
}

function getFullUrl(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  return `${window.location.origin}${href}`;
}

function handleMouseEnter(event: MouseEvent | CustomEvent<{ target: HTMLElement }>) {
  const target = (event.detail.target || event.target) as HTMLElement;
  const link = target?.closest("a");

  if (!link || !isValidLink(link)) {
    return;
  }

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  if (showTimeout) {
    clearTimeout(showTimeout);
  }

  const href = link.getAttribute("href")!;
  const fullUrl = getFullUrl(href);
  const rect = link.getBoundingClientRect();

  let x = rect.left + window.scrollX;
  const y = rect.bottom + window.scrollY + 8;

  const previewWidth = 320;
  if (x + previewWidth > window.innerWidth) {
    x = window.innerWidth - previewWidth - 16;
  }

  showTimeout = setTimeout(async () => {
    activePreview.value = {
      url: fullUrl,
      x,
      y,
      data: null,
      loading: true,
      error: false,
    };

    try {
      const data = await fetchMetadata(fullUrl);
      if (activePreview.value?.url === fullUrl) {
        activePreview.value = {
          ...activePreview.value,
          data,
          loading: false,
        };
      }
    } catch {
      if (activePreview.value?.url === fullUrl) {
        activePreview.value = {
          ...activePreview.value,
          loading: false,
          error: true,
        };
      }
    }
  }, 300);
}

function handleMouseLeave() {
  if (showTimeout) {
    clearTimeout(showTimeout);
    showTimeout = null;
  }

  hideTimeout = setTimeout(() => {
    activePreview.value = null;
  }, 200);
}

function handlePreviewEnter() {
  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }
}

function handlePreviewLeave() {
  hideTimeout = setTimeout(() => {
    activePreview.value = null;
  }, 200);
}

onMounted(() => {
  document.addEventListener("hover", handleMouseEnter);
  document.addEventListener("mouseover", handleMouseEnter);
  document.addEventListener("mouseout", handleMouseLeave);
});

onUnmounted(() => {
  document.removeEventListener("hover", handleMouseEnter);
  document.removeEventListener("mouseover", handleMouseEnter);
  document.removeEventListener("mouseout", handleMouseLeave);

  if (hideTimeout) clearTimeout(hideTimeout);
  if (showTimeout) clearTimeout(showTimeout);
});

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Updated today";
  if (diffDays === 1) return "Updated yesterday";
  if (diffDays < 7) return `Updated ${diffDays} days ago`;
  return `Updated ${date.toLocaleDateString()}`;
}

function isInternal(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin;
  } catch {
    return false;
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition-opacity duration-150"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="activePreview"
        class="fixed z-9999 bg-background dark:bg-neutral-800 max-w-[300px] rounded-lg shadow-xl border border-neutral-100 dark:border-neutral-700 overflow-hidden pointer-events-none"
        :style="{
          left: `${activePreview.x}px`,
          top: `${activePreview.y}px`,
        }"
        @mouseenter="handlePreviewEnter"
        @mouseleave="handlePreviewLeave"
      >
        <!-- Preview content -->
        <template v-if="activePreview.data">
          <!-- Image (external links only) -->
          <div
            v-if="activePreview.data.image"
            class="w-full h-40 bg-neutral-100 dark:bg-neutral-900"
          >
            <img
              :src="activePreview.data.image"
              :alt="activePreview.data.title || 'Preview'"
              class="w-full h-full object-cover"
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            />
          </div>

          <div class="p-4xs space-y-2">
            <!-- Site info -->
            <div class="flex items-center gap-2">
              <template v-if="isInternal(activePreview.url)">
                <svg class="w-4 h-4 text-primary-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </template>
              <template v-else>
                <img
                  v-if="activePreview.data.favicon"
                  :src="activePreview.data.favicon"
                  class="w-4 h-4"
                  @error="($event.target as HTMLImageElement).style.display = 'none'"
                />
              </template>
              <span class="text-xs text-neutral-500 truncate">
                {{ activePreview.data.siteName || getDomain(activePreview.url) }}
              </span>
            </div>

            <!-- Title -->
            <h4
              v-if="activePreview.data.title"
              class="font-medium text-sm text-neutral-900 dark:text-neutral-100 line-clamp-2"
            >
              {{ activePreview.data.title }}
            </h4>

            <!-- Description -->
            <p
              v-if="activePreview.data.description"
              class="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-2"
            >
              {{ activePreview.data.description }}
            </p>

            <!-- Updated time (internal links) -->
            <p
              v-if="activePreview.data.updatedAt"
              class="text-xs text-neutral-400"
            >
              {{ formatDate(activePreview.data.updatedAt) }}
            </p>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
