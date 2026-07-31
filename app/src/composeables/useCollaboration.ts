import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  useContext,
} from "solid-js";
import * as Y from "yjs";
import { api } from "#api/client.ts";
import type { PresenceEnvelope, PresenceUser } from "#realtime/protocol.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import { useCanvasCursorColor } from "./useCanvasCursorColor.ts";
import { useCosmetics } from "./useCosmetics.ts";
import { useUserProfile } from "./useUserProfile.ts";

export type CollaborationPresenceProfile<TState> = {
  clientId: string;
  user: PresenceUser;
  state: TState | null;
};

// Module scope: the composable holds a shared ref and installs no lifecycle
// hooks, so presenceColor() below can read it outside a component context.
const { cursorColorOverride } = useCanvasCursorColor();

/**
 * The local user's presence color: the explicit cursor-color preference when
 * set, otherwise the automatic avatar-derived color. Shared by canvas and
 * editor presence so a user shows up in one consistent color everywhere.
 */
function presenceColor(user: { id: string }): string {
  return cursorColorOverride() ?? getAvatarColor(user.id);
}

export type CollaborationSession<TPresenceState = unknown> = ReturnType<
  typeof useCollaboration<TPresenceState>
>;
/**
 * The session for the subtree below a provider.
 *
 * Vue's `provide`/`inject` becomes a context. The module-level fallback stays
 * for the same reason it existed before: `useActiveCollaboration` is read from
 * places that sit outside the provider — the canvas host among them — and
 * those need the current session without one.
 */
export const CollaborationContext = createContext<CollaborationSession | null>(null);
const [activeCollaboration, setActiveCollaboration] =
  createSignal<CollaborationSession | null>(null);

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

/**
 * Publishes a session as the active one.
 *
 * Callers still wrap their subtree in `CollaborationContext.Provider`; this
 * registers the same session for readers outside it and clears the
 * registration on disposal.
 */
export function provideCollaboration<TPresenceState>(
  collaboration: CollaborationSession<TPresenceState>,
) {
  setActiveCollaboration(() => collaboration as CollaborationSession);
  onCleanup(() => {
    if (activeCollaboration() === collaboration) setActiveCollaboration(null);
  });
}

export function injectCollaboration(): CollaborationSession | null {
  return useContext(CollaborationContext);
}

export function useActiveCollaboration(): Accessor<CollaborationSession | null> {
  const injected = useContext(CollaborationContext);
  return injected ? () => injected : activeCollaboration;
}

/**
 * A collaboration session.
 *
 * Usable from a Vue component, where it cleans itself up on unmount, and from
 * outside one, where the caller owns `dispose()`. The canvas needs the second
 * form: its inline document editor is a plain custom element, and a composable
 * that only tidies up via `onUnmounted` would leak its room membership and its
 * `pagehide`/`beforeunload` listeners there.
 */
export function useCollaboration<TPresenceState>(options: {
  spaceId: string;
  documentId: Accessor<string | undefined>;
  presenceRoomId?: Accessor<string | undefined>;
}) {
  const { spaceId, documentId } = options;
  // Watchers created outside a component are never stopped on their own. The
  // scope collects them so `dispose()` can, and it is inert for the component
  // callers, whose `onUnmounted` runs `dispose()` for them.
  const presenceRoomId = options.presenceRoomId ?? documentId;
  const user = useUserProfile();
  const { appearance } = useCosmetics();
  const [ydoc, setYdoc] = createSignal(new Y.Doc());
  const [localPresenceState, setLocalPresenceState] = createSignal<TPresenceState | null>(
    null,
  );
  const [presenceProfiles, setPresenceProfiles] = createSignal<
    CollaborationPresenceProfile<TPresenceState>[]
  >([]);
  const [roomPresenceProfiles, setRoomPresenceProfiles] = createSignal<
    CollaborationPresenceProfile<TPresenceState>[]
  >([]);

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
    const currentDocumentId = documentId();
    if (!currentDocumentId) return;
    if (joinedDocumentId && joinedDocumentId !== currentDocumentId) {
      leave();
    }
    if (!leaveYjsRoom) {
      yjsReady = waitForInitialSync((onSynced) => {
        // Returns a cleanup function that disconnects from the Y.js room.
        leaveYjsRoom = api.joinYjsRoom(spaceId, currentDocumentId, ydoc(), onSynced);
      });
      joinedDocumentId = currentDocumentId;
    }
    await yjsReady;
  }

  function syncPresenceProfiles() {
    setPresenceProfiles(
      [...remotePresences.values()].map((p) => ({
        clientId: p.clientId,
        user: p.user,
        state: p.state,
      })),
    );
  }

  function syncRoomPresenceProfiles() {
    const localUser = user();
    setRoomPresenceProfiles([
      ...(presenceHandle && localUser
        ? [
            {
              clientId,
              user: {
                id: localUser.id,
                name: localUser.name,
                image: localUser.image,
                color: presenceColor(localUser),
                appearance: appearance(),
              },
              state: localPresenceState(),
            } satisfies CollaborationPresenceProfile<TPresenceState>,
          ]
        : []),
      ...presenceProfiles(),
    ]);
  }

  function setPresenceState(state: TPresenceState | null) {
    setLocalPresenceState(() => state);
    syncRoomPresenceProfiles();
  }

  function updatePresence(state?: TPresenceState | null) {
    if (state !== undefined) {
      setPresenceState(state);
    }
    const current = localPresenceState();
    if (!presenceHandle || current === null) return;
    const serialized = JSON.stringify(current);
    if (serialized === lastPresenceState) return;
    lastPresenceState = serialized;
    presenceHandle.update(current);
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
    const roomId = presenceRoomId();
    const localUser = user();
    if (!roomId || !localUser || localPresenceState() === null || presenceHandle) {
      return;
    }

    presenceHandle = api.joinPresenceRoom<TPresenceState>(
      spaceId,
      roomId,
      clientId,
      {
        id: localUser.id,
        name: localUser.name,
        image: localUser.image,
        color: presenceColor(localUser),
        appearance: appearance(),
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
      localPresenceState() ?? undefined,
    );
    lastPresenceState = JSON.stringify(localPresenceState());
    syncRoomPresenceProfiles();
  }

  function leave() {
    clearPresence();
    leaveYjsRoom?.();
    leaveYjsRoom = null;
    yjsReady = null;
    joinedDocumentId = null;
    setYdoc(new Y.Doc());
  }
  createEffect(
    on(user, () => {
      if (presenceRequested) void setupPresence();
    }),
  );

  createEffect(
    on(documentId, (currentDocumentId, previousDocumentId) => {
      if (currentDocumentId === previousDocumentId) return;
      leave();
    }),
  );

  // The presence `user` (and its color) is only sent on join, so re-announce
  // when the cursor-color preference changes to broadcast the new color to
  // peers in both editor and canvas rooms.
  function handleCursorColorPreferenceChange() {
    syncRoomPresenceProfiles();
    if (!presenceHandle) return;
    clearPresence();
    void setupPresence();
  }
  createEffect(on(cursorColorOverride, handleCursorColorPreferenceChange));
  createEffect(on(appearance, handleCursorColorPreferenceChange));

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", clearPresence);
    window.addEventListener("beforeunload", clearPresence);
  }

  function dispose() {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", clearPresence);
      window.removeEventListener("beforeunload", clearPresence);
    }
    leave();
  }

  // Solid's owner handles this: inside a component or a `createRoot`, cleanup
  // runs on disposal, and the canvas host owns its own root. The Vue version
  // needed a `getCurrentInstance()` guard because `onUnmounted` silently did
  // nothing outside a component and the session outlived its creator.
  onCleanup(dispose);

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
    dispose,
  };
}
