<script setup lang="ts">
import { computed, watch } from "vue";
import { twMerge } from "tailwind-merge";
import AppView from "../AppView.vue";
import Breadcrumbs from "../Breadcrumbs.vue";
import DatabaseView from "../DatabaseView.vue";
import DocumentActions from "../DocumentActions.vue";
import DocumentContent from "../DocumentContent.vue";
import DocumentContextProvider from "../DocumentContextProvider.vue";
import DocumentProperties from "../DocumentProperties.vue";
import HeaderImage from "../HeaderImage.vue";
import RestoreButton from "../RestoreButton.vue";
import RevisionsSidebar from "../RevisionsSidebar.vue";
import RevisionView from "../RevisionView.vue";
import TitleEditor from "../TitleEditor.vue";
import WorkflowView from "../WorkflowView.vue";
import { api } from "../../api/client.ts";
import { useQuery } from "../../composeables/query.ts";
import { useSpace } from "../../composeables/useSpace.ts";
import { canEdit } from "../../composeables/usePermissions.ts";
import { readOnlyDocumentTypes } from "../../utils/documentTypes.ts";

const props = defineProps<{ documentSlug: string }>();

const { currentSpace } = useSpace();

const docQuery = useQuery({
  queryKey: computed(() => ["wiki_document_slug", currentSpace.value?.id, props.documentSlug]),
  queryFn: async () => {
    if (!currentSpace.value?.id || !props.documentSlug) return null;
    return await api.document.get(currentSpace.value.id, props.documentSlug);
  },
  enabled: computed(() => !!currentSpace.value?.id && !!props.documentSlug),
});

const breadcrumbsQuery = useQuery({
  queryKey: computed(() => ["document_breadcrumbs", currentSpace.value?.id, docQuery.data.value?.id]),
  queryFn: async () => {
    if (!currentSpace.value?.id || !docQuery.data.value?.id) return [];
    return await api.documentBreadcrumbs.get(currentSpace.value.id, docQuery.data.value.id);
  },
  enabled: computed(() => !!currentSpace.value?.id && !!docQuery.data.value?.id),
});

const doc = computed(() => docQuery.data.value);
const allBreadcrumbs = computed(() => breadcrumbsQuery.data.value ?? []);
// exclude the current doc from breadcrumbs
const parentBreadcrumbs = computed(() => allBreadcrumbs.value.slice(0, -1));

const title = computed(() => doc.value?.properties?.title || "Untitled Document");
const documentType = computed(() => doc.value?.type ?? "document");

const isCanvas = computed(() => documentType.value === "canvas");
const isApp = computed(() => documentType.value === "app");
const isCsv = computed(() => documentType.value === "csv");
const isWorkflow = computed(() => documentType.value === "workflow");
const isDatabase = computed(() => documentType.value === "database");
const isPaddedDocument = computed(
  () => !isCanvas.value && !isApp.value && !isCsv.value && !isWorkflow.value && !isDatabase.value,
);

const userCanEdit = computed(() => canEdit(currentSpace.value?.userRole));

const isReadonly = computed(() =>
  !!(
    doc.value?.readonly ||
    doc.value?.archived ||
    isCanvas.value ||
    isApp.value ||
    isWorkflow.value ||
    isDatabase.value ||
    readOnlyDocumentTypes.includes(documentType.value)
  ),
);

const defaultLayout = computed(() => (documentType.value === "document" ? "document" : "full"));
const effectiveLayout = computed(() => doc.value?.properties?.layout || defaultLayout.value);

const updatedAtStr = computed(() => {
  if (!doc.value?.updatedAt) return "";
  const diffMs = Date.now() - new Date(doc.value.updatedAt).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins >= 1 && diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
  if (diffHours >= 1 && diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
  if (diffDays >= 1) return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  return "just now";
});

watch(title, (t) => {
  if (t) document.title = `${t} - ${currentSpace.value?.name ?? ""} - Wiki`;
}, { immediate: true });
</script>

<template>
  <div v-if="doc && currentSpace">
    <div
      data-inset
      :class="twMerge('min-h-0 flex-1', !isCanvas && 'md:mr-(--inset-right) md:ml-(--inset-left)')"
    >
      <div
        :data-type="documentType"
        :data-updated-at="doc.updatedAt"
        :data-created-at="doc.createdAt"
        :data-layout="effectiveLayout"
        :class="twMerge(
          'relative mx-auto flex h-full w-full flex-col',
          isCsv || isDatabase || effectiveLayout === 'full'
            ? 'max-w-full'
            : 'max-w-(--document-width)',
        )"
      >
        <DocumentContextProvider
          :documentId="doc.id"
          :documentType="documentType"
          :readonly="isReadonly"
          :publishedVersion="doc.publishedRev"
          :userCanEdit="userCanEdit"
        />

        <div v-if="doc.archived" class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mx-4 md:mx-10">
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

        <HeaderImage
          v-if="!isCanvas && !isApp && !isWorkflow"
          :documentId="doc.id"
          :initialSrc="doc.properties?.headerImage ?? null"
        />

        <div
          :class="twMerge(
            isApp
              ? 'hidden'
              : isCanvas
                ? 'block pointer-events-none absolute top-xs right-0 left-0 z-20 md:right-(--inset-right) md:left-(--inset-left)'
                : 'mb-xl pt-xs contents',
          )"
        >
          <div
            :class="twMerge(
              'flex min-h-7 items-center justify-between px-xs md:px-xl print:px-0 mt-2xs mb-4xs',
              isCanvas && 'pointer-events-auto',
            )"
            data-inset
          >
            <div>
              <div v-if="isWorkflow" id="workflow-breadcrumb-slot" />
              <Breadcrumbs
                v-else
                :spaceSlug="currentSpace.slug"
                :category="null"
                :parents="parentBreadcrumbs"
                :currentTitle="title"
              />
            </div>
            <div
              v-if="doc.updatedAt"
              class="flex flex-wrap items-center gap-2 text-size-medium text-neutral-500"
            >
              <span v-if="updatedAtStr">Updated {{ updatedAtStr }}</span>
            </div>
          </div>

          <div
            :class="twMerge(
              'flex flex-row justify-between gap-6 py-3xs px-xs md:gap-4 md:px-xl print:px-0',
              isCanvas ? 'pointer-events-auto' : 'bg-neutral-10',
              'sticky top-0 z-10',
            )"
            data-inset
          >
            <div class="flex items-start justify-between w-full">
              <TitleEditor
                :initialEditMode="false"
                :title="title"
                :documentId="doc.id"
                :spaceId="currentSpace.id"
                :spaceSlug="currentSpace.slug"
                :canEdit="userCanEdit"
              />
            </div>
            <DocumentActions :title="title" />
          </div>

          <div
            id="document-properties"
            :class="twMerge('px-xs md:px-xl print:px-0 mb-l', isCanvas && 'pointer-events-auto')"
            data-inset
          >
            <DocumentProperties
              :documentId="doc.id"
              :documentType="documentType"
              :readonly="!userCanEdit"
              :initialProperties="{ ...doc.properties, parentId: doc.parentId }"
              :initialCategory="null"
            />
          </div>
        </div>

        <div
          :class="twMerge(
            'max-w-none text-neutral-700',
            isCsv || isDatabase
              ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
              : 'h-full overflow-x-auto',
            isPaddedDocument && 'px-xs md:px-xl print:px-0',
          )"
        >
          <RevisionView :documentId="doc.id" :documentType="documentType" :spaceId="currentSpace.id" />

          <AppView v-if="isApp" :html="doc.content || ''" />
          <WorkflowView v-else-if="isWorkflow" :documentId="doc.id" :spaceId="currentSpace.id" />
          <DatabaseView
            v-else-if="isDatabase"
            :databaseDocumentId="doc.id"
            :spaceSlug="currentSpace.slug"
            :schemaJson="doc.properties._schema"
          />
          <DocumentContent
            v-else
            :spaceId="currentSpace.id"
            :documentId="doc.id"
            :initialHtml="doc.content"
            :documentType="documentType"
            :readonly="isReadonly"
          />
        </div>
      </div>
    </div>
  </div>

  <div v-else-if="docQuery.isLoading.value" class="flex items-center justify-center h-64 text-neutral-400">
    Loading…
  </div>

  <Teleport to="body">
    <RevisionsSidebar v-if="doc" :documentId="doc.id" />
  </Teleport>
</template>
