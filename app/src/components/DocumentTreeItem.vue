<template>
  <page-target :data-document-id="doc.id"
    class="block [&[data-drag-over]]:bg-neutral-100 [&[data-dragging]]:opacity-50 pl-[0.535rem]">
    <div class="flex items-center gap-1">
      <button v-if="hasChildren" @click="$emit('toggle', doc.id)" class="p-0.5 hover:bg-neutral-300 active:bg-neutral-200 rounded-sm"
        :aria-label="isExpanded ? 'Collapse' : 'Expand'">
        <div class="svg-icon w-3 h-3 transition-transform text-neutral" :class="{ 'rotate-90': isExpanded }" v-html="chevronRightThinIcon" />
      </button>
      
      <div v-else class="flex-none w-4"></div>

      <a :href="getDocumentUrl(doc.slug)" :class="[
        'flex-1 px-2 py-1 text-size-medium rounded-md flex items-center justify-between whitespace-nowrap text-ellipsis',
        isActive
          ? 'bg-primary-200 text-neutral-700'
          : 'text-neutral-600 hover:bg-neutral-100 active:bg-neutral-200 hover:text-neutral-900'
      ]">
        <span>{{ doc.properties.title || 'Untitled' }}</span>
        <span v-if="doc.mentionCount && doc.mentionCount > 0" class="ml-2 px-1.5 py-0.5 text-size-small rounded-full bg-blue-500 text-white font-medium">
          {{ doc.mentionCount }}
        </span>
      </a>
    </div>

    <div v-if="isExpanded && hasChildren" class="mt-1 ml-2 space-y-1">
      <div v-for="(child, index) in children" :key="child.id" class="relative">
        <!-- continuous vertical rail for non-last items; extends through the space-y-1 gap -->
        <div
          v-if="index < children.length - 1"
          class="absolute left-0 top-0 bottom-[-0.25rem] w-px bg-neutral-300"
        ></div>
        <!-- L-shaped connector for the last item -->
        <div
          v-else
          class="absolute left-0 top-0 h-[14px] w-[0.535rem] border-l border-b border-neutral-400"
        ></div>
        <DocumentTreeItem :doc="child" :all-docs="allDocs"
          :active-doc-id="activeDocId" :expanded-items="expandedItems" @toggle="$emit('toggle', $event)" />
      </div>
    </div>
  </page-target>
</template>

<script setup>
import { computed } from "vue";
import { chevronRightThinIcon } from "~/src/assets/icons.ts";
import { useSpace } from "../composeables/useSpace.ts";

const props = defineProps({
  doc: {
    type: Object,
    required: true,
  },
  allDocs: {
    type: Array,
    required: true,
  },
  activeDocId: {
    type: String,
    default: null,
  },
  expandedItems: {
    type: Set,
    required: true,
  },
});

defineEmits(["toggle"]);

const { currentSpace } = useSpace();

const children = computed(() => {
  const docCategory = props.doc.properties.category || props.doc.properties.collection;

  return props.allDocs.filter((d) => {
    if (d.parentId !== props.doc.id) return false;

    const childCategory = d.properties.category || d.properties.collection;

    // Include child if it has no explicit category (inherits) or same category as parent
    return !childCategory || childCategory === docCategory;
  });
});

const hasChildren = computed(() => {
  return children.value.length > 0;
});

const isExpanded = computed(() => {
  return props.expandedItems.has(props.doc.id);
});

const isActive = computed(() => {
  return props.activeDocId === props.doc.slug;
});

function getDocumentUrl(docSlug) {
  return `/doc/${docSlug}`;
}
</script>
