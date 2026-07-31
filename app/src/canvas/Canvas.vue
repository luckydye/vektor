<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef, watchEffect } from "vue";
import type * as Y from "yjs";
import { useCanvasCursorColor } from "#composeables/useCanvasCursorColor.ts";
import type { CollaborationPresenceProfile } from "#composeables/useCollaboration.ts";
import { useCosmetics } from "#composeables/useCosmetics.ts";
import { useDocument } from "#composeables/useDocument.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { useUploads } from "#composeables/useUploads.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import type { CanvasPresenceState } from "#editor/collaboration.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { type CanvasHostElement, canvasHostTag } from "./CanvasHostElement.ts";

/**
 * The Vue adapter for `<vektor-canvas>`.
 *
 * The canvas itself is framework-free (plan section 6) and cannot call a
 * composable, so this resolves the six it used to reach for and writes them as
 * properties. Nothing else belongs here — no state, no rendering, no event
 * handling. When the app moves to Solid, this file is replaced by an equivalent
 * of the same size and the canvas is untouched.
 */
const props = defineProps<{
  spaceId: string;
  documentId?: string;
  ydoc: Y.Doc;
  presenceProfiles?: CollaborationPresenceProfile<CanvasPresenceState>[];
}>();

const emit = defineEmits<{ presence: [states: CanvasPresenceState[]] }>();

const host = useTemplateRef<CanvasHostElement>("host");
const toast = useToast();
const { document: documentData, saveDocument } = useDocument(props.documentId, "canvas");
const { currentSpace, spaces } = useSpace();
const { documents } = useDocuments();
const currentUser = useUserProfile();
const { appearance } = useCosmetics();
const { cursorColorOverride } = useCanvasCursorColor();
const { uploadFile } = useUploads();

// One effect for the whole property surface: every value below is reactive, and
// the element coalesces the writes into a single render anyway.
watchEffect(() => {
  const element = host.value;
  if (!element) return;

  element.spaceid = props.spaceId;
  element.documentid = props.documentId;
  element.ydoc = props.ydoc;
  element.presence = props.presenceProfiles ?? [];
  element.currentuserid = currentUser.value?.id;
  // An explicit preference overrides the automatic avatar colour; `null` means
  // automatic, so presence matches the user's avatar.
  element.cursorcolor =
    cursorColorOverride.value ?? getAvatarColor(currentUser.value?.id);
  element.cursorcompanion = appearance.cursorCompanion ?? null;
  element.canedit = canEdit(currentSpace.value?.userRole);
  element.gridtype = documentData.value?.properties?.gridtype as string | undefined;
  element.documents = () => documents.value;
  element.spaces = () => spaces.value;
  element.uploadfile = (file, target) => uploadFile(file, target);
  element.save = (snapshot) => saveDocument(snapshot as string);
  element.error = (message) => toast.error(message);
  element.onpresence = (states) => emit("presence", states);
  element.changed();
});

onMounted(() => {
  // The element only starts once `ydoc` is set, and the effect above runs
  // before mount on the first tick, so nudge it after the element exists.
  host.value?.changed();
});

onBeforeUnmount(() => host.value?.destroy());
</script>

<template>
  <component :is="canvasHostTag" ref="host" />
</template>
