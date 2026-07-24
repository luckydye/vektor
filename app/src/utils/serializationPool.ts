import * as Y from "yjs";
import { appLogger } from "#observability/logger.ts";
import { contentFromDoc, docFromContent } from "./serializationCore.ts";
import type {
  SerializationRequest,
  SerializationResponse,
} from "./serializationWorker.ts";

/**
 * A small pool of persistent workers that run document (de)serialization off
 * the main event loop. Large documents otherwise block the loop for seconds
 * (whole-doc HTML⇄ProseMirror⇄Yjs marshalling) and spike transient memory on
 * the request path.
 *
 * The pool is best-effort: if a worker fails to spawn or crashes, callers fall
 * back to serializing in-process, so correctness never depends on the workers.
 */

const POOL_SIZE = 2;
// Safety net: if a worker loses a message or wedges, reject so the caller falls
// back to in-process serialization instead of hanging the request forever.
const REQUEST_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (response: SerializationResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  workerEntry: PoolWorker;
}

interface PoolWorker {
  worker: Worker;
  inFlight: number;
}

let workers: PoolWorker[] | null = null;
let nextRequestId = 1;
let roundRobin = 0;
const pending = new Map<number, Pending>();

function settlePending(id: number): Pending | undefined {
  const waiter = pending.get(id);
  if (!waiter) return undefined;
  pending.delete(id);
  clearTimeout(waiter.timer);
  waiter.workerEntry.inFlight = Math.max(0, waiter.workerEntry.inFlight - 1);
  return waiter;
}

/** Rejects every in-flight request assigned to a worker that died. */
function failWorkerRequests(entry: PoolWorker, reason: string): void {
  for (const [id, waiter] of [...pending]) {
    if (waiter.workerEntry === entry) {
      settlePending(id)?.reject(new Error(reason));
    }
  }
}

function spawnWorker(): PoolWorker | null {
  try {
    const worker = new Worker(new URL("./serializationWorker.ts", import.meta.url), {
      type: "module",
    });
    const entry: PoolWorker = { worker, inFlight: 0 };

    worker.addEventListener("message", (event: MessageEvent<SerializationResponse>) => {
      settlePending(event.data.id)?.resolve(event.data);
    });

    worker.addEventListener("error", (event) => {
      appLogger.warn("Serialization worker errored; dropping it from the pool", {
        message: event.message,
      });
      // Drop the dead worker and reject its in-flight requests so their callers
      // fall back to in-process serialization. A fresh worker is spawned lazily
      // on the next request.
      workers = workers?.filter((w) => w !== entry) ?? null;
      failWorkerRequests(entry, "serialization worker crashed");
    });

    return entry;
  } catch (error) {
    appLogger.warn("Failed to spawn serialization worker; using in-process fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function ensurePool(): PoolWorker[] | null {
  if (!workers || workers.length === 0) {
    workers = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const spawned = spawnWorker();
      if (spawned) workers.push(spawned);
    }
    if (workers.length === 0) {
      workers = null;
      return null;
    }
  }
  return workers;
}

function pickWorker(pool: PoolWorker[]): PoolWorker {
  // Prefer an idle worker; otherwise round-robin so load spreads evenly.
  const idle = pool.find((w) => w.inFlight === 0);
  if (idle) return idle;
  const chosen = pool[roundRobin % pool.length] as PoolWorker;
  roundRobin++;
  return chosen;
}

// Distributive omit so each discriminated member keeps its own fields (a plain
// `Omit<Union, "id">` collapses to only the shared keys).
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function dispatch(
  request: WithoutId<SerializationRequest>,
): Promise<SerializationResponse> {
  const pool = ensurePool();
  if (!pool) return Promise.reject(new Error("serialization pool disabled"));

  const entry = pickWorker(pool);
  const id = nextRequestId++;
  entry.inFlight++;

  return new Promise<SerializationResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      settlePending(id)?.reject(new Error("serialization worker timed out"));
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer, workerEntry: entry });
    try {
      entry.worker.postMessage({ ...request, id } as SerializationRequest);
    } catch (error) {
      settlePending(id)?.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
}

/**
 * Serializes a Y.Doc to persisted content off-thread. Falls back to in-process
 * serialization if the pool is unavailable or the worker fails.
 */
export async function serializeDocContent(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
  doc: Y.Doc,
): Promise<string> {
  try {
    const update = Y.encodeStateAsUpdate(doc);
    const response = await dispatch({
      op: "serialize",
      spaceId,
      documentId,
      type: type ?? null,
      update,
    });
    if (response.ok && "content" in response) return response.content;
    throw new Error(response.ok ? "unexpected worker response" : response.error);
  } catch {
    return contentFromDoc(spaceId, documentId, type, doc);
  }
}

/**
 * Deserializes persisted content into a Y.Doc off-thread. Falls back to
 * in-process deserialization if the pool is unavailable or the worker fails.
 */
export async function deserializeDocContent(
  spaceId: string,
  documentId: string,
  type: string | null | undefined,
  content: string,
): Promise<Y.Doc> {
  try {
    const response = await dispatch({
      op: "deserialize",
      spaceId,
      documentId,
      type: type ?? null,
      content,
    });
    if (response.ok && "update" in response) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, response.update);
      return doc;
    }
    throw new Error(response.ok ? "unexpected worker response" : response.error);
  } catch {
    return docFromContent(spaceId, documentId, type, content);
  }
}

/** Terminates all pool workers (used on shutdown). */
export function stopSerializationPool(): void {
  for (const entry of workers ?? []) {
    entry.worker.terminate();
  }
  workers = null;
  for (const [, waiter] of pending) {
    waiter.reject(new Error("serialization pool stopped"));
  }
  pending.clear();
}
