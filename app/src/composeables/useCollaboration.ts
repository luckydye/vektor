import {
  type InjectionKey,
  inject,
  onUnmounted,
  provide,
  type Ref,
  type ShallowRef,
  shallowRef,
  watch,
} from "vue";
import * as Y from "yjs";
import type { PresenceEnvelope, PresenceUser } from "#utils/realtime.ts";
import { joinPresenceRoom, joinYjsRoom } from "#utils/sync.ts";
import { useUserProfile } from "./useUserProfile.ts";

export type CollaborationPresenceProfile<TState> = {
  clientId: string;
  user: PresenceUser;
  state: TState | null;
};

function getPresenceColor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return `hsl(${Math.abs(hash) % 360} 70% 55%)`;
}

export type CollaborationSession<TPresenceState = unknown> = ReturnType<
  typeof useCollaboration<TPresenceState>
>;
export const CollaborationKey: InjectionKey<CollaborationSession> =
  Symbol("Collaboration");
const activeCollaboration = shallowRef<CollaborationSession | null>(null);

const CLIENT_ID_STORAGE_KEY = "vektor:collaboration-client-id";
const CLIENT_ID_LEASE_PREFIX = "vektor:collaboration-client-lease:";
const CLIENT_ID_LEASE_MS = 8_000;
const CLIENT_ID_HEARTBEAT_MS = 4_000;

const pageInstanceId = createClientId();

function createClientId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `collaboration:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function clientIdLeaseKey(clientId: string) {
  return `${CLIENT_ID_LEASE_PREFIX}${clientId}`;
}

function hasActiveClientIdLease(clientId: string) {
  try {
    const raw = window.localStorage.getItem(clientIdLeaseKey(clientId));
    if (!raw) return false;
    const lease = JSON.parse(raw) as { owner?: string; updatedAt?: number };
    return (
      lease.owner !== pageInstanceId &&
      typeof lease.updatedAt === "number" &&
      Date.now() - lease.updatedAt < CLIENT_ID_LEASE_MS
    );
  } catch {
    return false;
  }
}

function writeClientIdLease(clientId: string) {
  try {
    window.localStorage.setItem(
      clientIdLeaseKey(clientId),
      JSON.stringify({ owner: pageInstanceId, updatedAt: Date.now() }),
    );
  } catch {
    // Best effort only. Presence still works; duplicate-window detection may not.
  }
}

function releaseClientIdLease(clientId: string) {
  try {
    const raw = window.localStorage.getItem(clientIdLeaseKey(clientId));
    if (!raw) return;
    const lease = JSON.parse(raw) as { owner?: string };
    if (lease.owner === pageInstanceId) {
      window.localStorage.removeItem(clientIdLeaseKey(clientId));
    }
  } catch {
    // Best effort only.
  }
}

function startClientIdHeartbeat(clientId: string) {
  writeClientIdLease(clientId);
  setInterval(() => {
    writeClientIdLease(clientId);
  }, CLIENT_ID_HEARTBEAT_MS);

  window.addEventListener("pagehide", () => releaseClientIdLease(clientId));
  window.addEventListener("beforeunload", () => releaseClientIdLease(clientId));
}

function getBrowserClientId() {
  if (typeof window === "undefined") {
    return createClientId();
  }

  try {
    const existing = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing && !hasActiveClientIdLease(existing)) {
      startClientIdHeartbeat(existing);
      return existing;
    }

    const next = createClientId();
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
    startClientIdHeartbeat(next);
    return next;
  } catch {
    return createClientId();
  }
}

const browserClientId = getBrowserClientId();

export function provideCollaboration<TPresenceState>(
  collaboration: CollaborationSession<TPresenceState>,
) {
  provide(CollaborationKey, collaboration as CollaborationSession);
  activeCollaboration.value = collaboration as CollaborationSession;
  onUnmounted(() => {
    if (activeCollaboration.value === collaboration) {
      activeCollaboration.value = null;
    }
  });
}

export function injectCollaboration() {
  return inject(CollaborationKey);
}

export function useActiveCollaboration(): ShallowRef<CollaborationSession | null> {
  const injected = inject(CollaborationKey, null);
  return injected
    ? (shallowRef(injected) as ShallowRef<CollaborationSession | null>)
    : activeCollaboration;
}

export function useCollaboration<TPresenceState>(options: {
  spaceId: string;
  documentId: Ref<string | undefined>;
  presenceRoomId?: Ref<string | undefined>;
}) {
  const { spaceId, documentId } = options;
  const presenceRoomId = options.presenceRoomId ?? documentId;
  const user = useUserProfile();
  const ydoc = shallowRef(new Y.Doc());
  const localPresenceState = shallowRef<TPresenceState | null>(null);
  const presenceProfiles = shallowRef<CollaborationPresenceProfile<TPresenceState>[]>([]);
  const roomPresenceProfiles = shallowRef<CollaborationPresenceProfile<TPresenceState>[]>(
    [],
  );

  const clientId = browserClientId;

  const remotePresences = new Map<string, PresenceEnvelope<TPresenceState>>();

  let leaveYjsRoom: (() => void) | null = null;
  let yjsReady: Promise<void> | null = null;
  let joinedDocumentId: string | null = null;
  let presenceHandle: {
    update: (state: TPresenceState) => void;
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

  function syncRoomPresenceProfiles() {
    const localUser = user.value;
    roomPresenceProfiles.value = [
      ...(presenceHandle && localUser
        ? [
            {
              clientId,
              user: {
                id: localUser.id,
                name: localUser.name,
                image: localUser.image,
                color: getPresenceColor(localUser.id),
              },
              state: localPresenceState.value,
            } satisfies CollaborationPresenceProfile<TPresenceState>,
          ]
        : []),
      ...presenceProfiles.value,
    ];
  }

  function setPresenceState(state: TPresenceState | null) {
    localPresenceState.value = state;
    syncRoomPresenceProfiles();
  }

  function updatePresence(state?: TPresenceState | null) {
    if (state !== undefined) {
      setPresenceState(state);
    }
    if (!presenceHandle || localPresenceState.value === null) return;
    const serialized = JSON.stringify(localPresenceState.value);
    if (serialized === lastPresenceState) return;
    lastPresenceState = serialized;
    presenceHandle.update(localPresenceState.value);
    syncRoomPresenceProfiles();
  }

  function clearPresence() {
    presenceRequested = false;
    presenceHandle?.leave();
    presenceHandle = null;
    lastPresenceState = "";
    remotePresences.clear();
    syncPresenceProfiles();
    syncRoomPresenceProfiles();
  }

  function isRemotePresence(presence: PresenceEnvelope<TPresenceState>) {
    return presence.clientId !== clientId;
  }

  async function setupPresence() {
    presenceRequested = true;
    const roomId = presenceRoomId.value;
    if (!roomId || !user.value || localPresenceState.value === null || presenceHandle) {
      return;
    }

    presenceHandle = joinPresenceRoom<TPresenceState>(
      spaceId,
      roomId,
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
            if (isRemotePresence(presence)) {
              remotePresences.set(presence.clientId, presence);
            }
          }
        } else if (event.type === "presence-update") {
          if (isRemotePresence(event.presence)) {
            remotePresences.set(event.presence.clientId, event.presence);
          } else {
            remotePresences.delete(event.presence.clientId);
          }
        } else {
          remotePresences.delete(event.clientId);
        }
        syncPresenceProfiles();
        syncRoomPresenceProfiles();
      },
      localPresenceState.value,
    );
    lastPresenceState = JSON.stringify(localPresenceState.value);
    syncRoomPresenceProfiles();
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

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", clearPresence);
    window.addEventListener("beforeunload", clearPresence);
  }

  onUnmounted(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", clearPresence);
      window.removeEventListener("beforeunload", clearPresence);
    }
    leave();
  });

  return {
    ydoc,
    localPresenceState,
    presenceProfiles,
    roomPresenceProfiles,
    joinUntilReady,
    leave,
    setupPresence,
    clearPresence,
    setPresenceState,
    updatePresence,
  };
}
