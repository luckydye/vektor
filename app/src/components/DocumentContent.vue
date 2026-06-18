<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type * as Y from "yjs";
import { api } from "../api/client.ts";
import { useQuery } from "../composeables/query.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useEditor } from "../composeables/useEditor.ts";
import { useInlineSuggestions } from "../composeables/useInlineSuggestions.ts";
import { useRevisions } from "../composeables/useRevisions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { useSync } from "../composeables/useSync.ts";
import { useYjsDocumentRoom } from "../composeables/useYjsDocumentRoom.ts";
import type { DocumentPresenceProfile } from "../editor/collaboration.ts";
import docStyles from "../styles/document.css?inline";
import { supportsComments } from "../utils/documentTypes.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import Canvas from "./Canvas.vue";
import type CommentBubble from "./CommentBubble.vue";
import CommentOverlays from "./CommentOverlays.vue";
import "../editor/elements/table-view.ts";
import "../editor/elements/toolbar.ts";
import "../components/document-statusbar.ts";

const props = withDefaults(
  defineProps<{
    documentId?: string;
    initialHtml?: string;
    documentType?: string;
    readonly?: boolean;
    spaceId: string;
    initialEditMode?: boolean;
  }>(),
  {
    initialHtml: "",
    documentType: "document",
    readonly: false,
    initialEditMode: false,
  },
);

const documentId = computed(() => props.documentId);
const documentType = computed(() => props.documentType || "document");
const documentReadonly = computed(() => props.readonly);

const canMountEditor = computed(
  () =>
    !documentReadonly.value &&
    documentType.value !== "canvas" &&
    documentType.value !== "app" &&
    documentType.value !== "csv",
);
const { currentSpaceId } = useSpace();
const pendingReload = ref(false);
const renderedHtml = ref(props.initialHtml || "");
type DocumentViewElement = HTMLElement & {
  collaborationDocument?: Y.Doc;
  destroyEditor?: () => void;
  renderReadHtml?: (html: string) => void;
  setPresenceProfiles?: (profiles: DocumentPresenceProfile[]) => void;
};
const documentViewEl = ref<DocumentViewElement | null>(null);
const isMounted = ref(false);
const commentBubble = ref<InstanceType<typeof CommentBubble> | null>(null);
const getEditor = () => globalThis.__editor;
type DocumentToolbarElement = HTMLElement & {
  dismiss?: () => void;
  openTextColorPicker?: () => void;
  openBackgroundColorPicker?: () => void;
};
const documentToolbar = ref<DocumentToolbarElement | null>(null);
const handleVisibilityChange = () => {
  if (pendingReload.value && document.visibilityState === "visible") {
    pendingReload.value = false;
    reloadIfReady();
  }
};

const editorRoom = useYjsDocumentRoom(props.spaceId, documentId.value);
const editorYdoc = editorRoom.ydoc;
const {
  saveStatus: docSaveStatus,
  saveError: docSaveError,
  saveDocument,
} = useDocument(documentId.value, documentType.value);
const { saveRevision } = useRevisions(documentId.value);
const { editing, cancelCount, resetEditingState, shouldMountEditor } = useEditor({
  spaceId: props.spaceId,
  documentId,
  canMountEditor,
  documentViewEl,
  documentToolbar,
  editorRoom,
  getEditor,
  documentSaveStatus: docSaveStatus,
  documentSaveError: docSaveError,
  saveDocument,
  saveRevision,
  refreshDocument: () => refreshDocument(),
});
const { handleInlineSuggestionAccept } = useInlineSuggestions({
  spaceId: currentSpaceId,
  documentId,
  isEditing: editing,
  getEditor,
});

watch(cancelCount, () => {
  if (typeof documentData.value?.content === "string") {
    renderedHtml.value = documentData.value.content;
  }
  reloadIfReady();
});

onMounted(() => {
  resetEditingState();
  isMounted.value = true;

  window.addEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );

  window.addEventListener("visibilitychange", handleVisibilityChange);

  if (props.initialEditMode && canMountEditor.value) {
    editing.value = true;
  }
});

onUnmounted(() => {
  window.removeEventListener(
    "inline-suggestion:accept",
    handleInlineSuggestionAccept as EventListener,
  );
  window.removeEventListener("visibilitychange", handleVisibilityChange);
});

function reloadIfReady() {
  if (editing.value) return;
  if (!documentId.value) return;
  refreshDocument();
}

const { data: documentData, refetch: refreshDocument } = useQuery({
  queryKey: computed(() => ["wiki_document", currentSpaceId.value, documentId.value]),
  queryFn: async () => {
    if (!currentSpaceId.value) {
      throw new Error("No space ID");
    }
    if (!documentId.value) {
      return null;
    }
    return await api.document.get(currentSpaceId.value, documentId.value);
  },
  enabled: computed(() => !!currentSpaceId.value && !!documentId.value),
});

watch(documentData, (doc) => {
  if (!doc) return;
  if (typeof doc.content === "string") {
    renderedHtml.value = doc.content;
  }
  const full =
    doc.properties?.layout === "full" ||
    (!doc.properties?.layout &&
      (documentType.value === "csv" || documentType.value === "canvas"));
  const container = document.querySelector<HTMLElement>("[data-layout]");
  container?.classList.toggle("max-w-full", full);
  container?.classList.toggle("max-w-(--document-width)", !full);
});

function escapeRawTextElement(value: string) {
  return value.replace(/<\/(script|style)/gi, "<\\/$1");
}

const ssrDeclarativeShadowDom = computed(() => {
  if (!import.meta.env.SSR) return "";
  return [
    '<template shadowrootmode="open">',
    `<style data-document-styles>${escapeRawTextElement(docStyles)}</style>`,
    '<div part="content"><div>',
    renderedHtml.value,
    "</div></div>",
    "</template>",
  ].join("");
});

useSync(
  currentSpaceId,
  () => (documentId.value ? [realtimeTopics.document(documentId.value)] : []),
  (scopes) => {
    if (!documentId.value) return;
    if (!scopes.includes(realtimeTopics.document(documentId.value))) return;

    if (document.visibilityState === "visible") {
      reloadIfReady();
    } else {
      pendingReload.value = true;
    }
  },
);
</script>

<template>
    <main class="relative">
        <!-- CSV Spreadsheet View -->
        <table-view v-if="!editing && documentType === 'csv'"
            :html="renderedHtml" class="block flex-1 min-h-0"></table-view>

        <!-- Document View (read + edit, single persistent instance) -->
        <div v-if="documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
            :class="editing ? 'h-full' : ''">
            <document-view ref="documentViewEl"
                :editor="shouldMountEditor && !documentReadonly ? '' : undefined"
                :collaborationDocument="editorYdoc"
                :html="renderedHtml"
                :space-id="props.spaceId" :document-id="documentId"
                v-html="ssrDeclarativeShadowDom" />
        </div>

        <div v-if="isMounted && documentType === 'canvas'" class="h-screen">
            <Canvas :documentId="documentId" :spaceId="props.spaceId" />
        </div>

        <div><!-- DON'T REMOVE; This fixes shadowDOM content not visible in print preview --></div>
    </main>

    <template v-if="documentId && supportsComments(documentType)">
        <CommentBubble ref="commentBubble" :spaceId="props.spaceId" :documentId="documentId"
            :currentRev="documentData?.currentRev" />
        <CommentOverlays :comments="commentBubble?.commentsForOverlays ?? []"
            @move="commentBubble?.handleMoveThread($event)" />
    </template>

    <document-statusbar
        v-if="editing && !documentReadonly && documentType !== 'canvas' && documentType !== 'app' && documentType !== 'csv'"
        class="block sticky left-0 bottom-0 pb-6 pt-20 bg-linear-to-b from-transparent to-neutral-10 pointer-events-none"></document-statusbar>
        
    <document-toolbar ref="documentToolbar"
        :data-comments-enabled="supportsComments(documentType) ? '' : undefined"></document-toolbar>
</template>
