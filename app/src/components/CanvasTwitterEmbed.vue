<script setup lang="ts">
// Renders an X/Twitter tweet embedded on the canvas. The server hands us the
// script-free oEmbed blockquote (see `url-metadata.ts`); we inject it and let
// Twitter's widgets.js hydrate it into the live embed. If the script is blocked
// or fails, the blockquote itself is a readable fallback with a link out.
//
// The hydrated tweet has a deterministic natural height (tweet + media at the
// current width), so we measure it and report it via `@resize`; the canvas
// grows the shape to fit instead of clipping it inside a fixed box.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { loadTwitterWidgets } from "#utils/twitterWidgets.ts";

const props = defineProps<{ html: string }>();
const emit = defineEmits<{ resize: [height: number] }>();

const container = ref<HTMLElement | null>(null);

let observer: ResizeObserver | null = null;

function reportHeight() {
  const el = container.value;
  if (!el) return;
  // scrollHeight reflects the full rendered tweet even while the container is
  // still clipped by the shape's current (smaller) height.
  const height = Math.ceil(el.scrollHeight);
  if (height > 0) emit("resize", height);
}

function observe(target: Element) {
  if (typeof ResizeObserver === "undefined") return;
  if (!observer) {
    observer = new ResizeObserver(() => reportHeight());
  }
  observer.observe(target);
}

async function hydrate() {
  const el = container.value;
  if (!el) return;
  try {
    const twttr = await loadTwitterWidgets();
    await twttr.widgets.load(el);
    // The iframe widgets.js injects resizes as the tweet (and its media) loads;
    // track it so the shape keeps fitting.
    const frame = el.querySelector("iframe");
    if (frame) observe(frame);
  } catch {
    // Leave the raw blockquote in place as a graceful fallback.
  }
  reportHeight();
}

onMounted(hydrate);
watch(
  () => props.html,
  () => {
    observer?.disconnect();
    void hydrate();
  },
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <!-- oEmbed markup comes from Twitter's publish API and is fetched script-free. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div ref="container" class="canvas-twitter-embed" v-html="props.html"></div>
</template>

<style scoped>
.canvas-twitter-embed {
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: flex;
  justify-content: center;
}
</style>
