import type * as Y from "yjs";

const SEED_CLIENT_ID = 1;

/**
 * Runs deterministic initial document construction under a stable Yjs client id.
 * The seed callback must perform the same operations in the same order for the
 * same persisted content so the resulting `(clientID, clock)` ids stay stable.
 */
export function withPinnedYjsSeed<T>(ydoc: Y.Doc, seed: () => T): T {
  const liveClientId = ydoc.clientID;
  ydoc.clientID = SEED_CLIENT_ID;
  try {
    return seed();
  } finally {
    // Live edits must never share the client id reserved for seeded structures.
    ydoc.clientID = liveClientId === SEED_CLIENT_ID ? SEED_CLIENT_ID + 1 : liveClientId;
  }
}
