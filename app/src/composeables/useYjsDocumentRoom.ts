import { shallowRef } from "vue";
import * as Y from "yjs";
import { joinYjsRoom } from "../utils/sync.ts";

export function useYjsDocumentRoom(spaceId: string, documentId?: string) {
  const ydoc = shallowRef(new Y.Doc());
  let leaveRoom: (() => void) | null = null;
  let ready: Promise<void> | null = null;

  function waitForInitialSync(doc: Y.Doc): Promise<void> {
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        doc.off("update", handleUpdate);
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      const handleUpdate = (_update: Uint8Array, origin: unknown) => {
        if (origin === "remote") cleanup();
      };

      doc.on("update", handleUpdate);
      timeout = setTimeout(cleanup, 1500);
    });
  }

  async function joinUntilReady() {
    if (!documentId) return;
    if (!leaveRoom) {
      ready = waitForInitialSync(ydoc.value);
      leaveRoom = joinYjsRoom(spaceId, documentId, ydoc.value);
    }
    await ready;
  }

  function leave() {
    leaveRoom?.();
    leaveRoom = null;
    ready = null;
    ydoc.value = new Y.Doc();
  }

  return {
    ydoc,
    joinUntilReady,
    leave,
  };
}
