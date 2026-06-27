<script setup lang="ts">
import { computed } from "vue";
import { twMerge } from "tailwind-merge";
import AppView from "./AppView.vue";
import Breadcrumbs from "./Breadcrumbs.vue";
import DatabaseView from "./DatabaseView.vue";
import DocumentActions from "./DocumentActions.vue";
import DocumentContent from "./DocumentContent.vue";
import DocumentContextProvider from "./DocumentContextProvider.vue";
import DocumentProperties from "./DocumentProperties.vue";
import HeaderImage from "./HeaderImage.vue";
import RestoreButton from "./RestoreButton.vue";
import RevisionsSidebar from "./RevisionsSidebar.vue";
import RevisionView from "./RevisionView.vue";
import TitleEditor from "./TitleEditor.vue";
import WorkflowView from "./WorkflowView.vue";

const props = defineProps<{
  spaceId: string;
  spaceSlug: string;
  documentId: string;
  documentType: string;
  title: string;
  initialHtml: string;
  readonly: boolean;
  userCanEdit: boolean;
  archived: boolean;
  publishedVersion: number | null;
  headerImageSrc: string | null;
  headerImageTransformed: string | null;
  parents: Array<{ id: string; title: string; slug: string }>;
  category: { id: string; name: string; slug: string } | null;
  effectiveLayout: string;
  updatedAt: string | null;
  createdAt: string | null;
  updatedAtStr: string;
  parentId: string | null;
  initialProperties: Record<string, unknown>;
}>();

const isCanvas = computed(() => props.documentType === "canvas");
const isApp = computed(() => props.documentType === "app");
const isCsv = computed(() => props.documentType === "csv");
const isWorkflow = computed(() => props.documentType === "workflow");
const isDatabase = computed(() => props.documentType === "database");
const isPaddedDocument = computed(
  () => !isCanvas.value && !isApp.value && !isCsv.value && !isWorkflow.value && !isDatabase.value,
);
</script>

<template>
  <div
    data-inset
    :class="twMerge('min-h-0 flex-1', !isCanvas && 'md:mr-(--inset-right) md:ml-(--inset-left)')"
  >
    <div
      :data-type="documentType"
      :data-updated-at="updatedAt"
      :data-created-at="createdAt"
      :data-layout="effectiveLayout"
      :class="twMerge(
        'relative mx-auto flex h-full w-full flex-col',
        isCsv || isDatabase || effectiveLayout === 'full'
          ? 'max-w-full'
          : 'max-w-(--document-width)',
      )"
    >
      <DocumentContextProvider
        :documentId="documentId"
        :documentType="documentType"
        :readonly="readonly"
        :publishedVersion="publishedVersion"
        :userCanEdit="userCanEdit"
      />

      <!-- Archived Document Disclaimer -->
      <div v-if="archived" class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mx-4 md:mx-10">
        <div class="flex items-start justify-between gap-3">
          <div class="space-y-2">
            <div class="text-yellow-600 font-semibold text-size-medium">
              ⚠️ This document is archived
            </div>
            <p class="text-yellow-700 text-size-medium">
              This document has been archived and is no longer actively maintained. You can view it
              here, but it may be out of date.
            </p>
          </div>
          <RestoreButton :documentId="documentId" />
        </div>
      </div>

      <!-- Header Image -->
      <HeaderImage
        v-if="!isCanvas && !isApp && !isWorkflow"
        :documentId="documentId"
        :initialSrc="headerImageSrc"
      />

      <!-- Document Header -->
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
              :spaceSlug="spaceSlug"
              :category="category"
              :parents="parents"
              :currentTitle="title"
            />
          </div>

          <div
            v-if="updatedAt"
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
              :documentId="documentId"
              :spaceId="spaceId"
              :spaceSlug="spaceSlug"
              :canEdit="userCanEdit"
            />
          </div>

          <DocumentActions :title="title" :headerImage="headerImageTransformed ?? undefined" />
        </div>

        <div
          id="document-properties"
          :class="twMerge('px-xs md:px-xl print:px-0 mb-l', isCanvas && 'pointer-events-auto')"
          data-inset
        >
          <DocumentProperties
            :documentId="documentId"
            :documentType="documentType"
            :readonly="!userCanEdit"
            :initialProperties="{ ...initialProperties, parentId }"
            :initialCategory="category"
          />
        </div>
      </div>

      <!-- Main Content -->
      <div
        :class="twMerge(
          'max-w-none text-neutral-700',
          isCsv || isDatabase
            ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
            : 'h-full overflow-x-auto',
          isPaddedDocument && 'px-xs md:px-xl print:px-0',
        )"
      >
        <RevisionView :documentId="documentId" :documentType="documentType" :spaceId="spaceId" />

        <AppView v-if="isApp" :html="initialHtml" />
        <WorkflowView v-else-if="isWorkflow" :documentId="documentId" :spaceId="spaceId" />
        <DatabaseView
          v-else-if="isDatabase"
          :databaseDocumentId="documentId"
          :spaceSlug="spaceSlug"
          :schemaJson="(initialProperties._schema as string | undefined)"
        />
        <DocumentContent
          v-else
          :spaceId="spaceId"
          :documentId="documentId"
          :initialHtml="initialHtml"
          :documentType="documentType"
          :readonly="readonly"
        />
      </div>
    </div>
  </div>

  <Teleport to="body">
    <RevisionsSidebar :documentId="documentId" />
  </Teleport>
</template>
