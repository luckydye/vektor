/**
 * The `.vcanvas` wire format: varints, tagged values, records and stroke
 * points. One codec for the stored file, the load response and the live op
 * frame (see docs/canvas-format.md, File layout).
 */

export const MAGIC = new Uint8Array([0x56, 0x43, 0x4e, 0x56]); // "VCNV"
export const FORMAT_VERSION = 1;
export const PREAMBLE_BYTES = MAGIC.length + 1;

export const RecordKind = {
  header: 0x01,
  index: 0x02,
  ids: 0x03,
  refs: 0x04,
  object: 0x10,
  cursor: 0x20,
} as const;

export type RecordKind = (typeof RecordKind)[keyof typeof RecordKind];

/** World-space AABB as `[x0, y0, x1, y1]`. */
export type BBox = [number, number, number, number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A property value: `null` removes the key. */
export type PropertyValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Writes of one timestamp: `(counter, writer)`; `writer` is 16 hex digits of a u64. */
export interface PropertyGroup {
  counter: number;
  writer: string;
  entries: [string, PropertyValue][];
}

export interface ObjectRecord {
  id: string;
  /** 0 from a client, the server's order otherwise; in a base, the covered `seq`. */
  seq: number;
  bbox: BBox;
  refs: string[];
  deleted: boolean;
  /** The record holds every property and the whole body. */
  full: boolean;
  groups: PropertyGroup[];
  /** A Yjs update for the body, empty for none. */
  body: Uint8Array;
}

export interface BaseHeader {
  count: number;
  coveredSeq: number;
  bounds: BBox;
  index: { offset: number; length: number };
  ids: { offset: number; length: number };
  refs: { offset: number; length: number };
}

const FLAG_DELETED = 1;
const FLAG_FULL = 2;

const ValueTag = {
  null: 0,
  false: 1,
  true: 2,
  f64: 3,
  string: 4,
  bytes: 5,
  json: 6,
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const TWO_POW_32 = 2 ** 32;

/** A growable little-endian byte buffer. */
export class ByteWriter {
  bytes = new Uint8Array(256);
  view = new DataView(this.bytes.buffer);
  length = 0;

  ensure(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    this.ensure(1);
    this.bytes[this.length++] = value;
  }

  u32(value: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, value, true);
    this.length += 4;
  }

  /** A u64 from a safe integer. */
  u64(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Not a u64: ${value}`);
    }
    this.ensure(8);
    this.view.setUint32(this.length, value % TWO_POW_32, true);
    this.view.setUint32(this.length + 4, Math.floor(value / TWO_POW_32), true);
    this.length += 8;
  }

  bigU64(value: bigint): void {
    this.ensure(8);
    this.view.setBigUint64(this.length, value, true);
    this.length += 8;
  }

  f32(value: number): void {
    this.ensure(4);
    this.view.setFloat32(this.length, value, true);
    this.length += 4;
  }

  f64(value: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, value, true);
    this.length += 8;
  }

  /** Unsigned LEB128 of a safe non-negative integer. */
  varint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Not a varint: ${value}`);
    }
    let rest = value;
    while (rest >= 0x80) {
      this.u8((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.u8(rest);
  }

  zigzag(value: number): void {
    this.varint(value < 0 ? -value * 2 - 1 : value * 2);
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  bytesField(bytes: Uint8Array): void {
    this.varint(bytes.length);
    this.raw(bytes);
  }

  string(value: string): void {
    this.bytesField(textEncoder.encode(value));
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

export class ByteReader {
  readonly view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  need(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new Error("Truncated canvas record");
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.offset++];
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  u64(): number {
    this.need(8);
    const low = this.view.getUint32(this.offset, true);
    const high = this.view.getUint32(this.offset + 4, true);
    this.offset += 8;
    const value = high * TWO_POW_32 + low;
    if (!Number.isSafeInteger(value)) throw new Error("u64 out of range");
    return value;
  }

  bigU64(): bigint {
    this.need(8);
    const value = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    while (true) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
      if (scale > 2 ** 56) throw new Error("Varint too long");
    }
    return value;
  }

  zigzag(): number {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  raw(count: number): Uint8Array {
    this.need(count);
    const bytes = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return bytes;
  }

  bytesField(): Uint8Array {
    return this.raw(this.varint());
  }

  string(): string {
    return textDecoder.decode(this.bytesField());
  }
}

/** Reads a varint at `offset` of `bytes`, or null when the bytes end first. */
export function peekVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; length: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = offset; i < bytes.length; i++) {
    const byte = bytes[i];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return { value, length: i - offset + 1 };
    scale *= 0x80;
  }
  return null;
}

export function writePreamble(writer: ByteWriter): void {
  writer.raw(MAGIC);
  writer.u8(FORMAT_VERSION);
}

export function preamble(): Uint8Array {
  const writer = new ByteWriter();
  writePreamble(writer);
  return writer.finish();
}

/** Asserts `bytes` start with the preamble this build reads. */
export function assertPreamble(bytes: Uint8Array): void {
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) throw new Error("Not a canvas file");
  }
  if (bytes[MAGIC.length] !== FORMAT_VERSION) {
    throw new Error(`Unsupported canvas format version ${bytes[MAGIC.length]}`);
  }
}

/** `kind | length | payload`. */
export function writeRecord(
  writer: ByteWriter,
  kind: RecordKind,
  payload: Uint8Array,
): void {
  writer.u8(kind);
  writer.varint(payload.length);
  writer.raw(payload);
}

export function encodeRecord(kind: RecordKind, payload: Uint8Array): Uint8Array {
  const writer = new ByteWriter();
  writeRecord(writer, kind, payload);
  return writer.finish();
}

/** The payload of the record whose bytes are `record`. */
export function recordPayload(record: Uint8Array): Uint8Array {
  const reader = new ByteReader(record);
  reader.u8();
  return reader.bytesField();
}

export interface RawRecord {
  kind: number;
  payload: Uint8Array;
}

/** Every record in `bytes`, which holds whole records and no preamble. */
export function* readRecords(bytes: Uint8Array): Generator<RawRecord> {
  const reader = new ByteReader(bytes);
  while (!reader.done) {
    const kind = reader.u8();
    yield { kind, payload: reader.bytesField() };
  }
}

function writeValue(writer: ByteWriter, value: PropertyValue): void {
  if (value === null) writer.u8(ValueTag.null);
  else if (value === false) writer.u8(ValueTag.false);
  else if (value === true) writer.u8(ValueTag.true);
  else if (typeof value === "number") {
    writer.u8(ValueTag.f64);
    writer.f64(value);
  } else if (typeof value === "string") {
    writer.u8(ValueTag.string);
    writer.string(value);
  } else if (value instanceof Uint8Array) {
    writer.u8(ValueTag.bytes);
    writer.bytesField(value);
  } else {
    writer.u8(ValueTag.json);
    writer.string(JSON.stringify(value));
  }
}

function readValue(reader: ByteReader): PropertyValue {
  const tag = reader.u8();
  switch (tag) {
    case ValueTag.null:
      return null;
    case ValueTag.false:
      return false;
    case ValueTag.true:
      return true;
    case ValueTag.f64:
      return reader.f64();
    case ValueTag.string:
      return reader.string();
    case ValueTag.bytes:
      return reader.bytesField().slice();
    case ValueTag.json:
      return JSON.parse(reader.string()) as PropertyValue;
    default:
      throw new Error(`Unknown canvas value tag ${tag}`);
  }
}

function writeWriter(writer: ByteWriter, id: string): void {
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`Not a writer id: ${id}`);
  writer.bigU64(BigInt(`0x${id}`));
}

function readWriter(reader: ByteReader): string {
  return reader.bigU64().toString(16).padStart(16, "0");
}

/** Narrows to f32, rounding outward so the box still contains the f64 one. */
export function outwardBBox(bbox: BBox): BBox {
  const down = (value: number) => {
    const narrow = Math.fround(value);
    return narrow > value ? nextFloat32(narrow, -1) : narrow;
  };
  const up = (value: number) => {
    const narrow = Math.fround(value);
    return narrow < value ? nextFloat32(narrow, 1) : narrow;
  };
  return [down(bbox[0]), down(bbox[1]), up(bbox[2]), up(bbox[3])];
}

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

function nextFloat32(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * 1.401298464324817e-45;
  f32Scratch[0] = value;
  const towardsLarger = value > 0 === direction > 0;
  u32Scratch[0] += towardsLarger ? 1 : -1;
  return f32Scratch[0];
}

export function assertBBox(bbox: BBox): void {
  if (!bbox.every(Number.isFinite) || bbox[0] > bbox[2] || bbox[1] > bbox[3]) {
    throw new Error(`Invalid canvas bbox ${bbox.join(",")}`);
  }
}

export function encodeObjectPayload(record: ObjectRecord): Uint8Array {
  const writer = new ByteWriter();
  writer.string(record.id);
  writer.varint(record.seq);
  for (const value of outwardBBox(record.bbox)) writer.f32(value);
  writer.varint(record.refs.length);
  for (const ref of record.refs) writer.string(ref);
  writer.u8((record.deleted ? FLAG_DELETED : 0) | (record.full ? FLAG_FULL : 0));
  writer.varint(record.groups.length);
  for (const group of record.groups) {
    writer.varint(group.counter);
    writeWriter(writer, group.writer);
    writer.varint(group.entries.length);
    for (const [key, value] of group.entries) {
      writer.string(key);
      writeValue(writer, value);
    }
  }
  writer.bytesField(record.body);
  return writer.finish();
}

export function encodeObjectRecord(record: ObjectRecord): Uint8Array {
  return encodeRecord(RecordKind.object, encodeObjectPayload(record));
}

export function decodeObjectPayload(payload: Uint8Array): ObjectRecord {
  const reader = new ByteReader(payload);
  const id = reader.string();
  const seq = reader.varint();
  const bbox: BBox = [reader.f32(), reader.f32(), reader.f32(), reader.f32()];
  const refs: string[] = [];
  for (let count = reader.varint(); count > 0; count--) refs.push(reader.string());
  const flags = reader.u8();
  const groups: PropertyGroup[] = [];
  for (let count = reader.varint(); count > 0; count--) {
    const counter = reader.varint();
    const writer = readWriter(reader);
    const entries: [string, PropertyValue][] = [];
    for (let n = reader.varint(); n > 0; n--) {
      const key = reader.string();
      entries.push([key, readValue(reader)]);
    }
    groups.push({ counter, writer, entries });
  }
  const body = reader.bytesField().slice();
  return {
    id,
    seq,
    bbox,
    refs,
    deleted: (flags & FLAG_DELETED) !== 0,
    full: (flags & FLAG_FULL) !== 0,
    groups,
    body,
  };
}

/** Rewrites the `seq` of an encoded object payload without decoding the rest. */
export function withSeq(payload: Uint8Array, seq: number): Uint8Array {
  const reader = new ByteReader(payload);
  reader.string();
  const seqStart = reader.offset;
  reader.varint();
  const writer = new ByteWriter();
  writer.raw(payload.subarray(0, seqStart));
  writer.varint(seq);
  writer.raw(payload.subarray(reader.offset));
  return writer.finish();
}

/** The leading fields of an object payload: what an index needs, and no values. */
export interface ObjectSummary {
  id: string;
  seq: number;
  bbox: BBox;
  refs: string[];
  deleted: boolean;
  full: boolean;
}

export function decodeObjectSummary(payload: Uint8Array): ObjectSummary {
  const reader = new ByteReader(payload);
  const id = reader.string();
  const seq = reader.varint();
  const bbox: BBox = [reader.f32(), reader.f32(), reader.f32(), reader.f32()];
  const refs: string[] = [];
  for (let count = reader.varint(); count > 0; count--) refs.push(reader.string());
  const flags = reader.u8();
  return {
    id,
    seq,
    bbox,
    refs,
    deleted: (flags & FLAG_DELETED) !== 0,
    full: (flags & FLAG_FULL) !== 0,
  };
}

/** Fixed width, so the offsets it holds do not depend on their own length. */
export const HEADER_PAYLOAD_BYTES = 4 + 8 + 16 + 6 * 8;

export function encodeHeaderPayload(header: BaseHeader): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(header.count);
  writer.u64(header.coveredSeq);
  for (const value of outwardBBox(header.bounds)) writer.f32(value);
  for (const span of [header.index, header.ids, header.refs]) {
    writer.u64(span.offset);
    writer.u64(span.length);
  }
  return writer.finish();
}

export function decodeHeaderPayload(payload: Uint8Array): BaseHeader {
  const reader = new ByteReader(payload);
  const count = reader.u32();
  const coveredSeq = reader.u64();
  const bounds: BBox = [reader.f32(), reader.f32(), reader.f32(), reader.f32()];
  const span = () => ({ offset: reader.u64(), length: reader.u64() });
  return { count, coveredSeq, bounds, index: span(), ids: span(), refs: span() };
}

/** Bytes of the header record, `kind | length | payload`, at the start of a base after the preamble. */
export const HEADER_RECORD_BYTES = 1 + 1 + HEADER_PAYLOAD_BYTES;

export function encodeCursorRecord(epoch: string): Uint8Array {
  const writer = new ByteWriter();
  writer.string(epoch);
  return encodeRecord(RecordKind.cursor, writer.finish());
}

export function decodeCursorPayload(payload: Uint8Array): string {
  return new ByteReader(payload).string();
}

export interface StrokePoint {
  x: number;
  y: number;
  width: number;
}

/** Points per world unit. */
const POINT_SCALE = 64;

/** Quantized to 1/64 world unit; deltas between quantized points, so errors do not add up. */
export function encodePoints(points: readonly StrokePoint[]): Uint8Array {
  const writer = new ByteWriter();
  writer.varint(points.length);
  let previous = { x: 0, y: 0, w: 0 };
  points.forEach((point, index) => {
    const current = {
      x: Math.round(point.x * POINT_SCALE),
      y: Math.round(point.y * POINT_SCALE),
      w: Math.max(0, Math.round(point.width * POINT_SCALE)),
    };
    if (index === 0) {
      writer.zigzag(current.x);
      writer.zigzag(current.y);
      writer.varint(current.w);
    } else {
      writer.zigzag(current.x - previous.x);
      writer.zigzag(current.y - previous.y);
      writer.zigzag(current.w - previous.w);
    }
    previous = current;
  });
  return writer.finish();
}

export function decodePoints(bytes: Uint8Array): StrokePoint[] {
  const reader = new ByteReader(bytes);
  const count = reader.varint();
  const points: StrokePoint[] = [];
  let x = 0;
  let y = 0;
  let w = 0;
  for (let index = 0; index < count; index++) {
    if (index === 0) {
      x = reader.zigzag();
      y = reader.zigzag();
      w = reader.varint();
    } else {
      x += reader.zigzag();
      y += reader.zigzag();
      w += reader.zigzag();
    }
    points.push({ x: x / POINT_SCALE, y: y / POINT_SCALE, width: w / POINT_SCALE });
  }
  return points;
}
