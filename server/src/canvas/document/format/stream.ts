import {
  assertPreamble,
  PREAMBLE_BYTES,
  peekVarint,
} from "#canvas/document/format/records.ts";

export interface StreamedRecord {
  kind: number;
  payload: Uint8Array;
  /** Offset of the record's `kind` byte from the start of the stream. */
  offset: number;
  /** Bytes of the whole record. */
  length: number;
}

/**
 * Decodes records as their bytes arrive. Every record decodes without reading
 * anything after it, so each is yielded as soon as its last byte is in.
 */
export async function* streamRecords(
  stream: ReadableStream<Uint8Array>,
  options: { preamble: boolean },
): AsyncGenerator<StreamedRecord> {
  let buffer = new Uint8Array(0);
  let start = 0;
  let consumed = 0;
  let preamblePending = options.preamble;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value && value.length > 0) {
        const rest = buffer.subarray(start);
        const next = new Uint8Array(rest.length + value.length);
        next.set(rest);
        next.set(value, rest.length);
        buffer = next;
        start = 0;
      }
      if (preamblePending && buffer.length - start >= PREAMBLE_BYTES) {
        assertPreamble(buffer.subarray(start));
        start += PREAMBLE_BYTES;
        consumed += PREAMBLE_BYTES;
        preamblePending = false;
      }
      while (!preamblePending && buffer.length - start >= 2) {
        const length = peekVarint(buffer, start + 1);
        if (!length) break;
        const total = 1 + length.length + length.value;
        if (buffer.length - start < total) break;
        const payloadStart = start + 1 + length.length;
        yield {
          kind: buffer[start],
          payload: buffer.slice(payloadStart, payloadStart + length.value),
          offset: consumed,
          length: total,
        };
        start += total;
        consumed += total;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (preamblePending || start < buffer.length) {
    throw new Error("Canvas stream ended inside a record");
  }
}
