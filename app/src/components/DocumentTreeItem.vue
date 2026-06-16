<template>
  <page-target :data-document-id="doc.id"
    class="block [&[data-drag-over]]:bg-neutral-100 [&[data-dragging]]:opacity-50 pl-1.5">
    <div class="flex items-center gap-1 px-1">
      <button v-if="hasChildren" @click="$emit('toggle', doc.id)" class="p-0.5 hover:bg-neutral-300 active:bg-neutral-200 rounded-sm"
        :aria-label="isExpanded ? 'Collapse' : 'Expand'">
        <div class="svg-icon w-3 h-3 transition-transform text-neutral" :class="{ 'rotate-90': isExpanded }" v-html="chevronRightThinIcon" />
      </button>
      
      <div v-else class="flex-none w-4"></div>

      <a :href="getDocumentUrl(doc.slug)" :class="[
        'flex-1 px-2 py-1.5 text-size-medium rounded-md flex items-center justify-between whitespace-nowrap text-ellipsis',
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

    <div v-if="isExpanded && hasChildren" class="mt-1 ml-3 border-l border-neutral-100 space-y-1">
      <DocumentTreeItem v-for="child in children" :key="child.id" :doc="child" :all-docs="allDocs"
        :active-doc-id="activeDocId" :expanded-items="expandedItems" @toggle="$emit('toggle', $event)" />
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
  if (currentSpace.value) {
    return `/${currentSpace.value.slug}/doc/${docSlug}`;
  }
  return `/doc/${docSlug}`;
}
</script>
