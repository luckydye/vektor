<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute as useVueRoute, useRouter } from "vue-router";
import { twMerge } from "tailwind-merge";
import DocumentActions from "../DocumentActions.vue";
import DocumentContent from "../DocumentContent.vue";
import DocumentContextProvider from "../DocumentContextProvider.vue";
import DocumentProperties from "../DocumentProperties.vue";
import NewDocumentPicker from "../NewDocumentPicker.vue";
import TitleEditor from "../TitleEditor.vue";
import { api } from "../../api/client.ts";
import { useSpace } from "../../composeables/useSpace.ts";
import { canEdit } from "../../composeables/usePermissions.ts";

const router = useRouter();
const vueRoute = useVueRoute();
const { currentSpace } = useSpace();

const typeParam = computed(() => (vueRoute.query.type as string) ?? "");
const type = computed(() => typeParam.value || "document");
const showPicker = computed(() => !typeParam.value);
const category = computed(() => (vueRoute.query.category as string) ?? undefined);
const title = computed(() => type.value === "canvas" ? "Untitled Canvas" : "Untitled Document");

const userCanEdit = computed(() => canEdit(currentSpace.value?.userRole));

const isCanvas = computed(() => type.value === "canvas");
const isApp = computed(() => type.value === "app");
const isCsv = computed(() => type.value === "csv");
const isWorkflow = computed(() => type.value === "workflow");
const isPaddedDocument = computed(() => !isCanvas.value && !isApp.value && !isCsv.value && !isWorkflow.value);

const AUTO_CREATE_TYPES: Record<string, string> = {
  database: "Untitled Database",
  canvas: "Untitled Canvas",
  workflow: "Untitled Workflow",
};

const redirecting = ref(false);

onMounted(async () => {
  const autoTitle = AUTO_CREATE_TYPES[type.value];
  if (!autoTitle || !currentSpace.value) return;
  if (!userCanEdit.value) {
    router.push("/");
    return;
  }
  redirecting.value = true;
  const doc = await api.documents.post(currentSpace.value.id, {
    type: type.value,
    content: "",
    properties: { title: autoTitle },
  });
  router.push(`/doc/${doc.slug}`);
});
</script>

<template>
  <inset-view
    v-if="currentSpace && !redirecting"
    :class="twMerge('block min-h-0 flex-1', !isCanvas && 'md:mr-(--inset-right) md:ml-(--inset-left)')"
  >
    <div
      :class="twMerge(
        'relative mx-auto flex h-full w-full flex-col',
        isCsv ? 'max-w-full' : 'max-w-(--document-width)',
      )"
    >
      <DocumentContextProvider
        :documentId="undefined"
        :documentType="type"
        :readonly="false"
        :publishedVersion="null"
        :userCanEdit="userCanEdit"
      />

      <!-- Document Header -->
      <div
        :class="twMerge(
          isApp
            ? 'hidden'
            : isCanvas
              ? 'block pointer-events-none absolute top-xs right-0 left-0 z-20 lg:right-(--inset-right) lg:left-(--inset-left)'
              : 'mb-xl pt-xs contents',
        )"
      >
        <inset-view
          class="block flex min-h-7 items-center justify-between px-xs lg:px-xl print:px-0 mt-2xs mb-4xs"
        >
          <div />
        </inset-view>

        <inset-view
          :class="twMerge(
            'block flex flex-row justify-between gap-6 py-3xs px-xs lg:gap-4 lg:px-xl print:px-0',
            isCanvas ? 'pointer-events-auto' : 'bg-neutral-10',
            'sticky top-0 z-10',
          )"
        >
          <div class="flex items-start justify-between w-full">
            <TitleEditor
              :initialEditMode="true"
              :title="title"
              :spaceId="currentSpace.id"

              :canEdit="userCanEdit"
            />
          </div>

          <DocumentActions :title="title" />
        </inset-view>

        <inset-view
          :class="twMerge('block px-xs lg:px-xl print:px-0 mb-l', isCanvas && 'pointer-events-auto')"
        >
          <DocumentProperties
            :documentId="undefined"
            :documentType="type"
            :initialProperties="category ? { category } : {}"
          />
        </inset-view>
      </div>

      <!-- Main Content -->
      <div
        :class="twMerge(
          'max-w-none overflow-x-auto text-neutral-700 h-full',
          isPaddedDocument && 'px-xs lg:px-xl print:px-0',
        )"
      >
        <NewDocumentPicker v-if="showPicker" />
        <DocumentContent :spaceId="currentSpace.id" :documentType="type" />
      </div>
    </div>
  </inset-view>
</template>
