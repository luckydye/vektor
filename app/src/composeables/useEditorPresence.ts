import { type Ref, ref, watch } from "vue";
import {
  type DocumentPresenceProfile,
  getPresenceColor,
} from "../editor/collaboration.ts";
import type { PresenceEnvelope } from "../utils/realtime.ts";
import { joinPresenceRoom } from "../utils/sync.ts";
import { useUserProfile } from "./useUserProfile.ts";

type DocumentPresenceState = NonNullable<DocumentPresenceProfile["state"]>;

export function useEditorPresence(options: {
  spaceId: string;
  documentId: Ref<string | undefined>;
  currentState: () => DocumentPresenceState;
  isActive: Ref<boolean>;
}) {
  const { spaceId, documentId, currentState, isActive } = options;
  const user = useUserProfile();
  const presenceProfiles = ref<DocumentPresenceProfile[]>([]);

  // Retry presence setup when the user profile loads after the editor started
  watch(user, () => {
    if (isActive.value) void setup();
  });

  const clientId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `editor:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const remotePresences = new Map<string, PresenceEnvelope<DocumentPresenceState>>();

  let presenceHandle: {
    update: (state: DocumentPresenceState) => void;
    leave: () => void;
  } | null = null;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;
  let lastPresenceState = "";

  function syncProfiles() {
    presenceProfiles.value = [...remotePresences.values()].map((p) => ({
      clientId: p.clientId,
      user: p.user,
      state: p.state,
    }));
  }

  function update() {
    if (!presenceHandle) return;
    const state = currentState();
    const serialized = JSON.stringify(state);
    if (serialized === lastPresenceState) return;
    lastPresenceState = serialized;
    presenceHandle.update(state);
  }

  function clear() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    presenceHandle?.leave();
    presenceHandle = null;
    lastPresenceState = "";
    remotePresences.clear();
    syncProfiles();
  }

  async function setup() {
    if (!documentId.value || !user.value || presenceHandle) return;

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
        syncProfiles();
      },
      currentState(),
    );
    lastPresenceState = JSON.stringify(currentState());
    presenceTimer = setInterval(update, 120);
  }

  return {
    setupEditorPresence: setup,
    clearEditorPresence: clear,
    updateEditorPresence: update,
    presenceProfiles,
  };
}
