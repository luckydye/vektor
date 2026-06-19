import {
  type InjectionKey,
  inject,
  onUnmounted,
  provide,
  type Ref,
  ref,
  shallowRef,
  watch,
} from "vue";
import * as Y from "yjs";
import {
  type DocumentPresenceProfile,
  getPresenceColor,
} from "../editor/collaboration.ts";
import type { PresenceEnvelope } from "../utils/realtime.ts";
import { joinPresenceRoom, joinYjsRoom } from "../utils/sync.ts";
import { useUserProfile } from "./useUserProfile.ts";

type DocumentPresenceState = NonNullable<DocumentPresenceProfile["state"]>;

export type CollaborationSession = ReturnType<typeof useCollaboration>;
export const CollaborationKey: InjectionKey<CollaborationSession> =
  Symbol("Collaboration");

export function provideCollaboration(collaboration: CollaborationSession) {
  provide(CollaborationKey, collaboration);
}

export function injectCollaboration() {
  return inject(CollaborationKey);
}

export function useCollaboration(options: {
  spaceId: string;
  documentId: Ref<string | undefined>;
  currentPresenceState?: () => DocumentPresenceState;
}) {
  const { spaceId, documentId, currentPresenceState } = options;
  const user = useUserProfile();
  const ydoc = shallowRef(new Y.Doc());
  const presenceProfiles = ref<DocumentPresenceProfile[]>([]);

  const clientId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `collaboration:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const remotePresences = new Map<string, PresenceEnvelope<DocumentPresenceState>>();

  let leaveYjsRoom: (() => void) | null = null;
  let yjsReady: Promise<void> | null = null;
  let joinedDocumentId: string | null = null;
  let presenceHandle: {
    update: (state: DocumentPresenceState) => void;
    leave: () => void;
  } | null = null;
  let lastPresenceState = "";
  let presenceRequested = false;

  function waitForInitialSync(onJoin: (onSynced: () => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for editor document sync"));
      }, 10_000);

      onJoin(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  async function joinUntilReady() {
    const currentDocumentId = documentId.value;
    if (!currentDocumentId) return;
    if (joinedDocumentId && joinedDocumentId !== currentDocumentId) {
      leave();
    }
    if (!leaveYjsRoom) {
      yjsReady = waitForInitialSync((onSynced) => {
        leaveYjsRoom = joinYjsRoom(spaceId, currentDocumentId, ydoc.value, onSynced);
      });
      joinedDocumentId = currentDocumentId;
    }
    await yjsReady;
  }

  function syncPresenceProfiles() {
    presenceProfiles.value = [...remotePresences.values()].map((p) => ({
      clientId: p.clientId,
      user: p.user,
      state: p.state,
    }));
  }

  function updatePresence() {
    if (!presenceHandle || !currentPresenceState) return;
    const state = currentPresenceState();
    const serialized = JSON.stringify(state);
    if (serialized === lastPresenceState) return;
    lastPresenceState = serialized;
    presenceHandle.update(state);
  }

  function clearPresence() {
    presenceRequested = false;
    presenceHandle?.leave();
    presenceHandle = null;
    lastPresenceState = "";
    remotePresences.clear();
    syncPresenceProfiles();
  }

  async function setupPresence() {
    presenceRequested = true;
    if (!documentId.value || !user.value || !currentPresenceState || presenceHandle) {
      return;
    }

    presenceHandle = joinPresenceRoom<DocumentPresenceState>(
      spaceId,
      documentId.value,
      clientId,
      {
        id: user.value.id,
        name: user.value.name,
        image: user.value.image,
        color: getPresenceColor(user.value.id),
      },
      (event) => {
        if (event.type === "presence-snapshot") {
          remotePresences.clear();
          for (const presence of event.presences) {
            if (presence.clientId !== clientId) {
              remotePresences.set(presence.clientId, presence);
            }
          }
        } else if (event.type === "presence-update") {
          if (event.presence.clientId !== clientId) {
            remotePresences.set(event.presence.clientId, event.presence);
          }
        } else {
          remotePresences.delete(event.clientId);
        }
        syncPresenceProfiles();
      },
      currentPresenceState(),
    );
    const initialState = currentPresenceState();
    lastPresenceState = JSON.stringify(initialState);
  }

  function leave() {
    clearPresence();
    leaveYjsRoom?.();
    leaveYjsRoom = null;
    yjsReady = null;
    joinedDocumentId = null;
    ydoc.value = new Y.Doc();
  }

  watch(user, () => {
    if (presenceRequested) void setupPresence();
  });

  watch(documentId, (currentDocumentId, previousDocumentId) => {
    if (currentDocumentId === previousDocumentId) return;
    leave();
  });

  onUnmounted(() => {
    leave();
  });

  return {
    ydoc,
    presenceProfiles,
    joinUntilReady,
    leave,
    setupPresence,
    clearPresence,
    updatePresence,
  };
}
