<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, inject, onMounted, onUnmounted, ref, watch, watchEffect } from "vue";
import { useRouter } from "vue-router";
import { api } from "../../api/client.ts";
import { useQuery } from "../../composeables/query.ts";
import { useDocumentContext } from "../../composeables/useDocument.ts";
import { useEditor } from "../../composeables/useEditor.ts";
import { canEdit } from "../../composeables/usePermissions.ts";
import { useSpace } from "../../composeables/useSpace.ts";
import { optionalPropertyValueToText } from "../../utils/documentProperties.ts";
import { readOnlyDocumentTypes } from "../../utils/documentTypes.ts";
import AppView from "../AppView.vue";
import Breadcrumbs from "../Breadcrumbs.vue";
import ClientOnly from "../ClientOnly.vue";
import DatabaseView from "../DatabaseView.vue";
import DocumentActions from "../DocumentActions.vue";
import DocumentContent from "../DocumentContent.vue";
import DocumentProperties from "../DocumentProperties.vue";
import HeaderImage from "../HeaderImage.vue";
import NewDocumentPicker from "../NewDocumentPicker.vue";
import RestoreButton from "../RestoreButton.vue";
import RevisionsSidebar from "../RevisionsSidebar.vue";
import RevisionView from "../RevisionView.vue";
import TitleEditor from "../TitleEditor.vue";
import WorkflowView from "../WorkflowView.vue";

const props = defineProps<{
  documentSlug?: string;
  draftType?: string;
  draftCategory?: string;
}>();
const router = useRouter();
const ssrNow = inject<number>("ssr:now", Date.now());
const now = ref(ssrNow);

const { currentSpace } = useSpace();
const { editing, resetEditingState } = useEditor();
const { canUseDocumentEditor, setDocumentContext, resetDocumentContext } =
  useDocumentContext();

const isDraft = computed(() => !props.documentSlug);
const draftTypeParam = computed(() => props.draftType ?? "");
const showPicker = computed(() => isDraft.value && !draftTypeParam.value);
const draftCategory = computed(() =>
  isDraft.value ? props.draftCategory || undefined : undefined,
);

const docQuery = useQuery({
  queryKey: computed(() => [
    "wiki_document_slug",
    currentSpace.value?.id,
    props.documentSlug,
  ]),
  queryFn: async () => {
    if (!currentSpace.value?.id || !props.documentSlug) return null;
    return await api.document.get(currentSpace.value.id, props.documentSlug);
  },
  enabled: computed(
    () => !isDraft.value && !!currentSpace.value?.id && !!props.documentSlug,
  ),
});

const breadcrumbsQuery = useQuery({
  queryKey: computed(() => [
    "document_breadcrumbs",
    currentSpace.value?.id,
    docQuery.data.value?.id,
  ]),
  queryFn: async () => {
    if (!currentSpace.value?.id || !docQuery.data.value?.id) return [];
    return await api.documentBreadcrumbs.get(
      currentSpace.value.id,
      docQuery.data.value.id,
    );
  },
  enabled: computed(
    () => !isDraft.value && !!currentSpace.value?.id && !!docQuery.data.value?.id,
  ),
});

const categoriesQuery = useQuery({
  queryKey: computed(() => ["categories", currentSpace.value?.id]),
  queryFn: async () => {
    if (!currentSpace.value?.id) return [];
    return await api.categories.get(currentSpace.value.id);
  },
  enabled: computed(() => !isDraft.value && !!currentSpace.value?.id),
});

const doc = computed(() => docQuery.data.value);

// Redirect /doc/documentId → /doc/documentSlug once the document resolves.
watch(
  doc,
  (d) => {
    if (!d || props.documentSlug === d.slug) return;
    const fullPath = router.currentRoute.value.fullPath;
    router.replace(fullPath.replace(`/doc/${props.documentSlug}`, `/doc/${d.slug}`));
  },
  { immediate: true },
);
const allBreadcrumbs = computed(() => breadcrumbsQuery.data.value ?? []);
// exclude the current doc from breadcrumbs
const parentBreadcrumbs = computed(() => allBreadcrumbs.value.slice(0, -1));

const docCategory = computed(() => {
  const categories = categoriesQuery.data.value;
  if (!categories) return null;
  // Walk the breadcrumb chain from root to current and use the first category found.
  for (const crumb of allBreadcrumbs.value) {
    if (crumb.categorySlug) {
      return categories.find((c) => c.slug === crumb.categorySlug) ?? null;
    }
  }
  return null;
});

const documentType = computed(() =>
  isDraft.value ? draftTypeParam.value || "document" : (doc.value?.type ?? "document"),
);

const isCanvas = computed(() => documentType.value === "canvas");
const isApp = computed(() => documentType.value === "app");
const isCsv = computed(() => documentType.value === "csv");
const isWorkflow = computed(() => documentType.value === "workflow");
const isDatabase = computed(() => documentType.value === "database");
const isPaddedDocument = computed(
  () =>
    !isCanvas.value &&
    !isApp.value &&
    !isCsv.value &&
    !isWorkflow.value &&
    !isDatabase.value,
);

const userCanEdit = computed(() => canEdit(currentSpace.value?.userRole));

const isReadonly = computed(() =>
  isDraft.value
    ? false
    : !!(
        doc.value?.readonly ||
        doc.value?.archived ||
        isCanvas.value ||
        isApp.value ||
        isWorkflow.value ||
        isDatabase.value ||
        readOnlyDocumentTypes.includes(documentType.value)
      ),
);

const title = computed(() =>
  isDraft.value
    ? documentType.value === "canvas"
      ? "Untitled Canvas"
      : "Untitled Document"
    : doc.value?.properties?.title || "Untitled Document",
);

const defaultLayout = computed(() =>
  documentType.value === "document" ? "document" : "full",
);
const effectiveLayout = computed(() =>
  isDraft.value
    ? defaultLayout.value
    : doc.value?.properties?.layout || defaultLayout.value,
);

const updatedAtStr = computed(() => {
  if (!doc.value?.updatedAt) return "";
  const diffMs = now.value - new Date(doc.value.updatedAt).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins >= 1 && diffMins < 60)
    return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
  if (diffHours >= 1 && diffHours < 24)
    return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  if (diffDays >= 1) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  return "just now";
});

const AUTO_CREATE_TYPES: Record<string, string> = {
  database: "Untitled Database",
  canvas: "Untitled Canvas",
  workflow: "Untitled Workflow",
};

const redirecting = ref(false);

async function maybeAutoCreateDraft() {
  if (!isDraft.value) return;
  const autoTitle = AUTO_CREATE_TYPES[documentType.value];
  if (!autoTitle || !currentSpace.value) return;
  if (!userCanEdit.value) {
    router.push("/");
    return;
  }
  redirecting.value = true;
  const newDoc = await api.documents.post(currentSpace.value.id, {
    type: documentType.value,
    content: "",
    properties: { title: autoTitle },
  });
  router.push(`/doc/${newDoc.slug}`);
}

onMounted(() => {
  now.value = Date.now();
  void maybeAutoCreateDraft();
});

onUnmounted(() => {
  resetEditingState();
  resetDocumentContext();
});

watch(
  title,
  (t) => {
    if (typeof document === "undefined") return;
    if (t) document.title = `${t} - ${currentSpace.value?.name ?? ""} - Wiki`;
  },
  { immediate: true },
);

// Keep the shared document context in sync with the current document.
// Runs during setup (SSR + client) so the context is correct before any child
// component renders. Replaces the renderless DocumentContextProvider component.
watchEffect(() => {
  setDocumentContext({
    documentId: doc.value?.id,
    documentType: documentType.value,
    readonly: isReadonly.value,
    publishedVersion: doc.value?.publishedRev ?? null,
    userCanEdit: userCanEdit.value,
  });
  if (!canUseDocumentEditor.value && editing.value) {
    resetEditingState();
  }
});
</script>

<template>
    <div v-if="currentSpace && (isDraft ? !redirecting : doc)">
        <inset-view :key="doc?.id ?? 'draft'"
            :class="twMerge('block min-h-0 flex-1', !isCanvas && 'md:mr-(--inset-right) md:ml-(--inset-left)')">
            <div :data-type="documentType" :data-updated-at="doc?.updatedAt" :data-created-at="doc?.createdAt"
                :data-layout="effectiveLayout" :class="twMerge(
                    'relative mx-auto flex h-full w-full flex-col',
                    isCsv || isDatabase || effectiveLayout === 'full'
                        ? 'max-w-full'
                        : 'max-w-(--document-width)',
                )">

                <div v-if="doc?.archived" class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mx-4 md:mx-10">
                    <div class="flex items-start justify-between gap-3">
                        <div class="space-y-2">
                            <div class="text-yellow-600 font-semibold text-size-medium">
                                ⚠️ This document is archived
                            </div>
                            <p class="text-yellow-700 text-size-medium">
                                This document has been archived and is no longer actively maintained.
                            </p>
                        </div>
                        <RestoreButton :documentId="doc.id" />
                    </div>
                </div>

                <!-- Document Header (no wrapper for normal docs so sticky title works) -->
                <template v-if="isCanvas">
                    <div class="block pointer-events-none absolute top-0 right-0 left-0 z-20 md:right-(--inset-right) md:left-(--inset-left)">
                        <div class="px-xs md:px-xl mt-4 min-h-7">
                            <div v-if="isWorkflow" id="workflow-breadcrumb-slot" />
                            <Breadcrumbs v-else-if="!isDraft" :category="docCategory" :parents="parentBreadcrumbs"
                                :currentTitle="title" />
                        </div>

                        <HeaderImage v-if="!isDraft && !isApp && !isWorkflow && !isCanvas" class="mt-4 mb-4" :documentId="doc.id"
                            :initialSrc="optionalPropertyValueToText(doc.properties?.headerImage)" />

                        <inset-view :class="twMerge(
                            'flex flex-row justify-between gap-6 py-3xs px-xs md:gap-4 md:px-xl print:px-0',
                            'pointer-events-auto',
                            'sticky top-0 z-10',
                        )">
                            <div class="flex items-start justify-between w-full">
                                <TitleEditor :initialEditMode="isDraft" :title="title" :documentId="doc?.id"
                                    :spaceId="currentSpace.id" :canEdit="userCanEdit" />
                            </div>
                            <DocumentActions :title="title" />
                        </inset-view>

                        <inset-view id="document-properties"
                            :class="twMerge('block px-xs md:px-xl print:px-0 mb-l', 'pointer-events-auto')">
                            <DocumentProperties :documentId="doc?.id" :documentType="documentType"
                                :readonly="!userCanEdit"
                                :initialProperties="isDraft ? (draftCategory ? { category: draftCategory } : {}) : { ...doc.properties, parentId: doc.parentId }"
                                :initialCategory="null" />
                        </inset-view>
                    </div>
                </template>

                <template v-else-if="!isApp">
                    <div class="px-xs md:px-xl mt-4 min-h-7">
                        <div v-if="isWorkflow" id="workflow-breadcrumb-slot" />
                        <Breadcrumbs v-else-if="!isDraft" :category="docCategory" :parents="parentBreadcrumbs"
                            :currentTitle="title" />
                    </div>

                    <HeaderImage v-if="!isDraft && !isWorkflow" class="mt-4 mb-4" :documentId="doc.id"
                        :initialSrc="optionalPropertyValueToText(doc.properties?.headerImage)" />

                    <inset-view :class="twMerge(
                        'flex flex-row justify-between gap-6 py-3xs px-xs md:gap-4 md:px-xl print:px-0',
                        'bg-neutral-10',
                        'sticky top-0 z-10',
                    )">
                        <div class="flex items-start justify-between w-full">
                            <TitleEditor :initialEditMode="isDraft" :title="title" :documentId="doc?.id"
                                :spaceId="currentSpace.id" :canEdit="userCanEdit" />
                        </div>
                        <DocumentActions :title="title" />
                    </inset-view>

                    <inset-view id="document-properties"
                        :class="twMerge('block px-xs md:px-xl print:px-0 mb-l')">
                        <DocumentProperties :documentId="doc?.id" :documentType="documentType"
                            :readonly="!userCanEdit"
                            :initialProperties="isDraft ? (draftCategory ? { category: draftCategory } : {}) : { ...doc.properties, parentId: doc.parentId }"
                            :initialCategory="null" />
                    </inset-view>
                </template>

                <div :class="twMerge(
                    'max-w-none text-neutral-700 h-full overflow-x-auto',
                    isCsv || isDatabase
                        ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                        : 'h-full overflow-x-auto',
                    isPaddedDocument && 'px-xs md:px-xl print:px-0',
                )">
                    <template v-if="isDraft">
                        <NewDocumentPicker v-if="showPicker" />
                        <DocumentContent :spaceId="currentSpace.id" :documentType="documentType" />
                    </template>
                    <template v-else>
                        <RevisionView :documentId="doc.id" :documentType="documentType" :spaceId="currentSpace.id" />

                        <AppView v-if="isApp" :html="doc.content || ''" />
                        <WorkflowView v-else-if="isWorkflow" :documentId="doc.id" :spaceId="currentSpace.id" />
                        <DatabaseView v-else-if="isDatabase" :databaseDocumentId="doc.id" :schemaJson="optionalPropertyValueToText(doc.properties._schema) ?? undefined" />
                        <DocumentContent v-else :spaceId="currentSpace.id" :documentId="doc.id" :initialHtml="doc.content"
                            :documentType="documentType" :readonly="isReadonly" />
                    </template>
                </div>

                <inset-view
                    v-if="!isDraft && !editing && !isCanvas"
                    :class="twMerge(
                    'flex items-center justify-between px-xs md:px-xl print:px-0 mt-2xs mb-4xs',
                      isCanvas && 'pointer-events-auto',
                    )"
                >
                    <div
                        v-if="doc?.updatedAt"
                        class="flex flex-wrap items-center gap-2 text-size-medium text-neutral-500"
                    >
                    <ClientOnly>
                        <span v-if="updatedAtStr">Updated {{ updatedAtStr }}</span>
                    </ClientOnly>
                    </div>
                </inset-view>
            </div>
        </inset-view>
    </div>

    <div v-else-if="!isDraft && docQuery.isLoading.value" class="flex items-center justify-center h-64 text-neutral-400">
        Loading…
    </div>

    <div v-else-if="!isDraft" class="flex flex-col items-center justify-center min-h-[60vh] gap-3 text-neutral-500">
        <p class="text-2xl font-semibold text-neutral-800">404</p>
        <p>Document not found.</p>
        <a :href="`/${currentSpace?.slug ?? ''}/`" class="text-sm underline hover:text-neutral-800">Back to space</a>
    </div>

    <ClientOnly>
        <Teleport to="body">
            <RevisionsSidebar v-if="!isDraft && doc" :documentId="doc.id" />
        </Teleport>
    </ClientOnly>
</template>
