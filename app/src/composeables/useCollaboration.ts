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
import {
  CollaborationJoinAbandoned,
  CollaborationResetRequired,
} from "#editor/collaboration.ts";
import type { PresenceEnvelope, PresenceUser } from "#realtime/protocol.ts";
import { getAvatarColor } from "#utils/avatarColor.ts";
import {
  readStored,
  removeStored,
  storedText,
  writeStored,
} from "#utils/clientStorage.ts";
import { useCanvasCursorColor } from "./useCanvasCursorColor.ts";
import { useCosmetics } from "./useCosmetics.ts";
import { useToast } from "./useToast.ts";
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
 * The module-level fallback exists because `useActiveCollaboration` is read
 * from places that sit outside the provider — the canvas host among them —
 * and those need the current session without one.
 */
export const CollaborationContext = createContext<CollaborationSession | null>(null);
const [activeCollaboration, setActiveCollaboration] =
  createSignal<CollaborationSession | null>(null);

/**
 * Reports a join failure that nothing else is waiting on, to the console and to
 * the user. An abandoned join is neither: the caller left the room on purpose.
 *
 * Callers that surface the failure themselves — a toast of their own, or an
 * error painted into the view — must not route it through here.
 */
export function reportJoinFailure(error: unknown): void {
  if (error instanceof CollaborationJoinAbandoned) return;
  console.error("Could not join the collaboration room", error);
  const reason = error instanceof Error ? error.message : String(error);
  useToast().error(`Could not sync this document: ${reason}`);
}

/** Budget for the server's first state frame, counted only while connected. */
const SYNC_TIMEOUT_MS = 20_000;
/** Ceiling for the whole wait, so a socket that never opens still reports. */
const SYNC_OFFLINE_TIMEOUT_MS = 60_000;
const SYNC_WATCHDOG_INTERVAL_MS = 500;

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
  const lease = readStored<{ owner?: string; updatedAt?: number }>(
    clientIdLeaseKey(clientId),
  );
  if (!lease) return false;
  return (
    lease.owner !== pageInstanceId &&
    typeof lease.updatedAt === "number" &&
    Date.now() - lease.updatedAt < CLIENT_ID_LEASE_MS
  );
}

// Best effort: if the write fails, presence still works but duplicate-window
// detection may not.
function writeClientIdLease(clientId: string) {
  writeStored(clientIdLeaseKey(clientId), {
    owner: pageInstanceId,
    updatedAt: Date.now(),
  });
}

function releaseClientIdLease(clientId: string) {
  const lease = readStored<{ owner?: string }>(clientIdLeaseKey(clientId));
  // Only ever drop our own lease: another window's is still live.
  if (lease?.owner === pageInstanceId) removeStored(clientIdLeaseKey(clientId));
}

function startClientIdHeartbeat(clientId: string) {
  writeClientIdLease(clientId);
  setInterval(() => {
    writeClientIdLease(clientId);
  }, CLIENT_ID_HEARTBEAT_MS);

  window.addEventListener("pagehide", () => releaseClientIdLease(clientId));
  window.addEventListener("beforeunload", () => releaseClientIdLease(clientId));
}

/**
 * This tab's client ID, reused across reloads but never across tabs.
 *
 * `session` is load-bearing, not a default: two tabs sharing one client ID is
 * exactly the duplicate-presence case the lease below exists to detect. The ID
 * must die with the tab, so it can never live in `local`.
 */
const CLIENT_ID_SESSION = { ...storedText, area: "session" as const };

function getBrowserClientId() {
  if (typeof window === "undefined") {
    return createClientId();
  }

  const existing = readStored(CLIENT_ID_STORAGE_KEY, CLIENT_ID_SESSION);
  if (existing && !hasActiveClientIdLease(existing)) {
    startClientIdHeartbeat(existing);
    return existing;
  }

  const next = createClientId();
  writeStored(CLIENT_ID_STORAGE_KEY, next, CLIENT_ID_SESSION);
  startClientIdHeartbeat(next);
  return next;
}

/** The identity this tab presents in any presence room. */
export const browserClientId = getBrowserClientId();

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
 * Usable from a component, where it cleans itself up on disposal, and from
 * outside one, where the caller owns `dispose()`. The canvas needs the second
 * form: its inline document editor is a plain custom element that would
 * otherwise leak its room membership and its `pagehide`/`beforeunload`
 * listeners.
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
  let cancelSyncWait: (() => void) | null = null;

  /**
   * Waits for the server's first state frame, or for the server to refuse the
   * room. Gives up after `SYNC_TIMEOUT_MS` of *connected* time: the join is
   * replayed on the next open, so a socket that is down is not a document that
   * will never sync. Both budgets are counted in watchdog ticks, which a
   * background tab throttles, so they are floors rather than wall-clock.
   */
  function waitForInitialSync(
    onJoin: (onSynced: () => void, onFailed: (error: Error) => void) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let elapsedMs = 0;
      let connectedMs = 0;
      let settled = false;

      // The four outcomes race — synced, refused, timed out, abandoned — and
      // whichever lands first owns the watchdog and the promise.
      function settle(error: Error | null): void {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        cancelSyncWait = null;
        if (error) reject(error);
        else resolve();
      }

      const watchdog = setInterval(() => {
        elapsedMs += SYNC_WATCHDOG_INTERVAL_MS;
        if (api.isRealtimeConnected(spaceId)) connectedMs += SYNC_WATCHDOG_INTERVAL_MS;
        const failure =
          connectedMs >= SYNC_TIMEOUT_MS
            ? "Timed out waiting for editor document sync"
            : elapsedMs >= SYNC_OFFLINE_TIMEOUT_MS
              ? "Timed out waiting for the realtime connection"
              : null;
        if (failure) settle(new Error(failure));
      }, SYNC_WATCHDOG_INTERVAL_MS);

      cancelSyncWait = () => settle(new CollaborationJoinAbandoned());

      onJoin(
        () => settle(null),
        (error) => settle(error),
      );
    });
  }

  async function joinUntilReady() {
    const currentDocumentId = documentId();
    if (!currentDocumentId) return;
    if (joinedDocumentId && joinedDocumentId !== currentDocumentId) {
      leave();
    }
    if (!leaveYjsRoom) {
      const pending = waitForInitialSync((onSynced, onFailed) => {
        // Returns a cleanup function that disconnects from the Y.js room.
        leaveYjsRoom = api.joinYjsRoom(
          spaceId,
          currentDocumentId,
          ydoc(),
          onSynced,
          onFailed,
          () => onFailed(new CollaborationResetRequired()),
        );
      });
      // A join that failed still holds the room and a document that never
      // synced, and rejoining an already-held room resolves against that stale
      // copy. Dropping both makes a retry a real join instead of a replay of
      // this rejection.
      yjsReady = pending.catch((error: unknown) => {
        if (
          !(error instanceof CollaborationJoinAbandoned) &&
          joinedDocumentId === currentDocumentId
        ) {
          leave();
        }
        throw error;
      });
      joinedDocumentId = currentDocumentId;
    }

    try {
      await yjsReady;
    } catch (error) {
      if (error instanceof CollaborationResetRequired) {
        await joinUntilReady();
        return;
      }
      throw error;
    }
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
    // The room this join was waiting on is being dropped, so nothing will ever
    // answer it; left alone the watchdog would report that as a sync failure.
    cancelSyncWait?.();
    cancelSyncWait = null;
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
      // Consumers rejoin from their own effect on the same id, and the order
      // of the two is not guaranteed. Once the session already holds the room
      // for this id, leaving would drop that membership and swap in an empty
      // document that nothing rejoins.
      if (joinedDocumentId === currentDocumentId) return;
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
  // runs on disposal, and the canvas host owns its own root.
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
