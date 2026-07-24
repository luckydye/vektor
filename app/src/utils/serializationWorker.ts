/// <reference lib="webworker" />
import * as Y from "yjs";
import { contentFromDoc, docFromContent, docFromUpdate } from "./serializationCore.ts";

/**
 * Serialization worker: runs the CPU- and allocation-heavy document
 * (de)serialization off the main event loop. Messages are structured-cloneable
 * — Yjs state travels as binary updates, content as strings — so the live
 * Y.Doc never leaves the main thread.
 */

export type SerializationRequest =
  | {
      id: number;
      op: "serialize";
      spaceId: string;
      documentId: string;
      type: string | null;
      update: Uint8Array;
    }
  | {
      id: number;
      op: "deserialize";
      spaceId: string;
      documentId: string;
      type: string | null;
      content: string;
    };

export type SerializationResponse =
  | { id: number; ok: true; content: string }
  | { id: number; ok: true; update: Uint8Array }
  | { id: number; ok: false; error: string };

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<SerializationRequest>) => void) | null;
  postMessage: (message: SerializationResponse) => void;
};

ctx.onmessage = (event) => {
  const req = event.data;
  try {
    if (req.op === "serialize") {
      const doc = docFromUpdate(req.update);
      const content = contentFromDoc(req.spaceId, req.documentId, req.type, doc);
      ctx.postMessage({ id: req.id, ok: true, content });
    } else {
      const doc = docFromContent(req.spaceId, req.documentId, req.type, req.content);
      const update = Y.encodeStateAsUpdate(doc);
      ctx.postMessage({ id: req.id, ok: true, update });
    }
  } catch (error) {
    ctx.postMessage({
      id: req.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
