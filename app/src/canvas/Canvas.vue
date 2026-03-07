<script setup lang="ts">
import "./components/CanvasElement.ts";
import type CanvasElement from "./components/CanvasElement.ts";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { joinPresenceRoom, joinYjsRoom } from "../utils/sync.ts";
import { useDocument } from "../composeables/useDocument.ts";
import { useUserProfile } from "../composeables/useUserProfile.ts";
import type { PresenceEnvelope } from "../utils/realtime.ts";

const canvasRef = ref<CanvasElement>();
const user = useUserProfile();

const props = defineProps<{
  spaceId: string;
  documentId?: string;
}>();

const { saveDocument } = useDocument(props.documentId, "canvas");
const roomId = props.documentId || crypto.randomUUID();
const presenceClientId = crypto.randomUUID();
let leaveYjsRoom = () => {};
let leavePresenceRoom = () => {};
let saveInterval: ReturnType<typeof setInterval> | null = null;
let presenceInterval: ReturnType<typeof setInterval> | null = null;

type CanvasPresenceState = {
  kind: "canvas";
  pointer: { x: number; y: number } | null;
  view: { x: number; y: number; scale: number };
  selectionIds: string[];
  focusedNodeId: string | null;
  activeTool: string | null;
};

function getPresenceColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }

  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

async function manualSave() {
  const canvas = canvasRef.value?.canvas;

  if (canvas) {
    const content = canvas.toString();
    await saveDocument(content);
  }
}

function setupPresence() {
  const canvasElement = canvasRef.value;

  if (!canvasElement || !user.value || presenceInterval) {
    return;
  }

  const presence = joinPresenceRoom<CanvasPresenceState>(
    props.spaceId,
    roomId,
    presenceClientId,
    {
      id: user.value.id,
      name: user.value.name,
      image: user.value.image,
      color: getPresenceColor(user.value.id),
    },
    (event) => {
      const presences = new Map<string, PresenceEnvelope<CanvasPresenceState>>();
      const current = canvasElement.remotePresences ?? new Map<string, PresenceEnvelope<CanvasPresenceState>>();
      if (event.type === "presence-snapshot") {
        for (const presence of event.presences) {
          if (presence.clientId === presenceClientId) continue;
          presences.set(presence.clientId, presence);
        }
        canvasElement.setRemotePresences(presences);
        return;
      }

      for (const [key, value] of current.entries()) {
        presences.set(key, value);
      }

      if (event.type === "presence-update") {
        if (event.presence.clientId !== presenceClientId) {
          presences.set(event.presence.clientId, event.presence);
        }
      } else {
        presences.delete(event.clientId);
      }

      canvasElement.setRemotePresences(presences);
    },
    canvasElement.getPresenceState(),
  );
  leavePresenceRoom = presence.leave;
  presenceInterval = setInterval(() => {
    presence.update(canvasElement.getPresenceState());
  }, 100);
}

onMounted(() => {
  const canvas = canvasRef.value?.canvas;
  if (canvas) {
    leaveYjsRoom = joinYjsRoom(props.spaceId, roomId, canvas.doc);
  }

  setupPresence();

  if (!saveInterval) {
    saveInterval = setInterval(() => manualSave(), 5000);
  }
});

watch(user, () => {
  setupPresence();
});

onUnmounted(() => {
  leavePresenceRoom();
  leaveYjsRoom();
  if (saveInterval) {
    clearInterval(saveInterval);
  }
  if (presenceInterval) {
    clearInterval(presenceInterval);
  }
});
</script>

<template>
    <div class="w-full h-full relative overflow-hidden">
        <canvas-element ref="canvasRef" class="block w-full h-full relative"></canvas-element>
    </div>
</template>
