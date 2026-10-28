/**
 * The `ids` and `refs` tables: fixed-width `hash u64 | recordOffset u64`
 * entries sorted by hash, so a lookup is a binary search. `hash` is the first
 * 8 bytes of SHA-256 of an id; a match is a candidate the reader confirms by
 * decoding the record.
 *
 * Server-only: it hashes with `node:crypto`.
 */

import { createHash } from "node:crypto";
import { ByteReader, ByteWriter } from "#canvas/document/format/records.ts";

export interface LookupTable {
  hashes: BigUint64Array;
  offsets: Float64Array;
}

export function idHash(id: string): bigint {
  return createHash("sha256").update(id, "utf8").digest().readBigUInt64BE(0);
}

export function buildLookup(entries: { hash: bigint; offset: number }[]): LookupTable {
  entries.sort((a, b) =>
    a.hash !== b.hash ? (a.hash < b.hash ? -1 : 1) : a.offset - b.offset,
  );
  const hashes = new BigUint64Array(entries.length);
  const offsets = new Float64Array(entries.length);
  entries.forEach((entry, i) => {
    hashes[i] = entry.hash;
    offsets[i] = entry.offset;
  });
  return { hashes, offsets };
}

export function encodeLookup(table: LookupTable): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(table.hashes.length);
  for (let i = 0; i < table.hashes.length; i++) {
    writer.bigU64(table.hashes[i]);
    writer.u64(table.offsets[i]);
  }
  return writer.finish();
}

export function decodeLookup(payload: Uint8Array): LookupTable {
  const reader = new ByteReader(payload);
  const count = reader.u32();
  const hashes = new BigUint64Array(count);
  const offsets = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    hashes[i] = reader.bigU64();
    offsets[i] = reader.u64();
  }
  return { hashes, offsets };
}

/** Record offsets whose entry hash equals `hash`. */
export function lookupOffsets(table: LookupTable, hash: bigint): number[] {
  let low = 0;
  let high = table.hashes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (table.hashes[mid] < hash) low = mid + 1;
    else high = mid;
  }
  const found: number[] = [];
  for (let i = low; i < table.hashes.length && table.hashes[i] === hash; i++) {
    found.push(table.offsets[i]);
  }
  return found;
}
