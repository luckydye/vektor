/**
 * Parses Figma clipboard HTML (fig-kiwi binary format).
 *
 * Wire format:
 *   data-metadata span  →  base64 figmeta JSON (file key, selected node IDs)
 *   data-buffer span    →  base64 binary blob:
 *     bytes 0-7   magic "fig-kiwi"
 *     bytes 8-11  version (uint32 LE)
 *     bytes 12-15 schema chunk size (uint32 LE)
 *     bytes 16..  schema chunk (deflate-raw → binary kiwi schema)
 *     next 4      data chunk size (uint32 LE)
 *     next N      data chunk (zstd → kiwi-encoded Message)
 *
 * kiwi-schema only knows 6 primitive types; Figma also uses int64 (index -7)
 * and uint64 (index -8). We remap those to int/uint (values we care about —
 * positions, sizes, field IDs — fit in 32-bit range).
 */

import { decompress as fzstdDecompress } from "fzstd";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FigmaMeta {
  fileKey: string;
  pasteID: number;
  dataType: string;
  environment: string;
  selectedNodeData: string;
}

export interface FigmaNode {
  type: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string; // hex string, e.g. "#3b82f6"
  text?: string; // characters for TEXT nodes
}

// ---------------------------------------------------------------------------
// ByteBuffer — minimal reader (mirrors kiwi-schema/bb.js)
// ---------------------------------------------------------------------------

const int32 = new Int32Array(1);
const float32 = new Float32Array(int32.buffer);

class ByteBuffer {
  private data: Uint8Array;
  private pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  readByte(): number {
    return this.data[this.pos++];
  }

  readVarUint(): number {
    let v = 0,
      shift = 0;
    do {
      const b = this.readByte();
      v |= (b & 127) << shift;
      shift += 7;
      if (!(b & 128)) break;
    } while (shift < 35);
    return v >>> 0;
  }

  readVarInt(): number {
    const u = this.readVarUint();
    return u & 1 ? ~(u >>> 1) : u >>> 1;
  }

  readFloat(): number {
    const first = this.data[this.pos];
    if (first === 0) {
      this.pos++;
      return 0;
    }
    const bits =
      first |
      (this.data[this.pos + 1] << 8) |
      (this.data[this.pos + 2] << 16) |
      (this.data[this.pos + 3] << 24);
    this.pos += 4;
    int32[0] = (bits << 23) | (bits >>> 9);
    return float32[0];
  }

  readString(): string {
    let s = "";
    while (true) {
      const a = this.readByte();
      if (a === 0) return s;
      let cp: number;
      if (a < 0xc0) {
        cp = a;
      } else if (a < 0xe0) {
        cp = ((a & 0x1f) << 6) | (this.readByte() & 0x3f);
      } else if (a < 0xf0) {
        const b = this.readByte();
        cp = ((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (this.readByte() & 0x3f);
      } else {
        const b = this.readByte();
        const c = this.readByte();
        cp =
          ((a & 0x07) << 18) |
          ((b & 0x3f) << 12) |
          ((c & 0x3f) << 6) |
          (this.readByte() & 0x3f);
      }
      s += String.fromCodePoint(cp);
    }
  }

  readByteArray(): Uint8Array {
    const len = this.readVarUint();
    const result = this.data.slice(this.pos, this.pos + len);
    this.pos += len;
    return result;
  }

  get offset(): number {
    return this.pos;
  }
}

// ---------------------------------------------------------------------------
// Binary schema decoder
// ---------------------------------------------------------------------------

const PRIMITIVES = [
  "bool",
  "byte",
  "int",
  "uint",
  "float",
  "string",
  "int",
  "uint",
] as const;
type PrimType = (typeof PRIMITIVES)[number];

type FieldKind = "ENUM" | "STRUCT" | "MESSAGE";

interface SchemaField {
  name: string;
  type: string | null; // null for ENUM fields
  isArray: boolean;
  value: number; // field ID (MESSAGE) or enum value (ENUM)
}

interface TypeDef {
  name: string;
  kind: FieldKind;
  fields: SchemaField[];
}

function decodeBinarySchema(schemaBytes: Uint8Array): TypeDef[] {
  const bb = new ByteBuffer(schemaBytes);
  const count = bb.readVarUint();
  const defs: TypeDef[] = [];

  for (let i = 0; i < count; i++) {
    const name = bb.readString();
    const kindByte = bb.readByte();
    const kind: FieldKind =
      kindByte === 1 ? "STRUCT" : kindByte === 2 ? "MESSAGE" : "ENUM";
    const fieldCount = bb.readVarUint();
    const fields: SchemaField[] = [];

    for (let j = 0; j < fieldCount; j++) {
      const fname = bb.readString();
      const typeRaw = bb.readVarInt(); // always consume, even for ENUM fields
      const isArray = !!(bb.readByte() & 1);
      const value = bb.readVarUint();
      fields.push({
        name: fname,
        type: kind === "ENUM" ? null : (typeRaw as unknown as string), // resolve below
        isArray,
        value,
      });
    }
    defs.push({ name, kind, fields });
  }

  // Resolve numeric type references to names
  for (const def of defs) {
    for (const field of def.fields) {
      if (field.type === null) continue;
      const t = field.type as unknown as number;
      if (t < 0) {
        field.type = (PRIMITIVES[~t] as PrimType | undefined) ?? "uint";
      } else {
        field.type = defs[t]?.name ?? "uint";
      }
    }
  }

  return defs;
}

// ---------------------------------------------------------------------------
// Kiwi message decoder
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type KiwiValue = any;

function decodeMessage(
  bb: ByteBuffer,
  typeName: string,
  schemaIndex: Map<string, TypeDef>,
): KiwiValue {
  const def = schemaIndex.get(typeName);
  if (!def) return {};
  const result: KiwiValue = {};

  if (def.kind === "STRUCT") {
    for (const field of def.fields) {
      const t = field.type ?? "uint";
      result[field.name] = field.isArray
        ? readArray(bb, t, schemaIndex)
        : readValue(bb, t, schemaIndex);
    }
  } else if (def.kind === "MESSAGE") {
    const fieldById = new Map(def.fields.map((f) => [f.value, f]));
    while (true) {
      const id = bb.readVarUint();
      if (id === 0) break;
      const field = fieldById.get(id);
      if (!field) break; // unknown field — can't skip safely, stop
      const t = field.type ?? "uint";
      result[field.name] = field.isArray
        ? readArray(bb, t, schemaIndex)
        : readValue(bb, t, schemaIndex);
    }
  }

  return result;
}

function readValue(
  bb: ByteBuffer,
  typeName: string,
  schemaIndex: Map<string, TypeDef>,
): KiwiValue {
  switch (typeName) {
    case "bool":
      return !!bb.readByte();
    case "byte":
      return bb.readByte();
    case "int":
      return bb.readVarInt();
    case "uint":
      return bb.readVarUint();
    case "float":
      return bb.readFloat();
    case "string":
      return bb.readString();
    default: {
      const def = schemaIndex.get(typeName);
      if (!def) return 0;
      if (def.kind === "ENUM") return bb.readVarUint();
      return decodeMessage(bb, typeName, schemaIndex);
    }
  }
}

function readArray(
  bb: ByteBuffer,
  typeName: string,
  schemaIndex: Map<string, TypeDef>,
): KiwiValue[] {
  if (typeName === "byte") return Array.from(bb.readByteArray());
  const len = bb.readVarUint();
  const arr: KiwiValue[] = new Array(len);
  for (let i = 0; i < len; i++) arr[i] = readValue(bb, typeName, schemaIndex);
  return arr;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractBase64(html: string, start: string, end: string): string {
  const si = html.indexOf(start);
  const ei = html.indexOf(end);
  if (si === -1 || ei === -1) return "";
  return html.substring(si + start.length, ei);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function toHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((v) =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function enumName(defs: TypeDef[], typeName: string, value: number): string {
  const def = defs.find((d) => d.name === typeName);
  return def?.fields.find((f) => f.value === value)?.name ?? String(value);
}

function nodeGuidKey(n: KiwiValue): string | null {
  const g = n.guid as KiwiValue | undefined;
  if (!g) return null;
  return `${g.sessionID}:${g.localID}`;
}

// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------

async function decompress(
  data: Uint8Array,
  format: CompressionFormat,
): Promise<Uint8Array> {
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  void writer.write(data as BufferSource);
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// Chrome 123+ supports zstd natively; fall back to fzstd for other browsers.
async function decompressZstd(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await decompress(data, "zstd" as CompressionFormat);
  } catch {
    return fzstdDecompress(data);
  }
}

// ---------------------------------------------------------------------------
// Shared decode pipeline
// ---------------------------------------------------------------------------

async function decodeFigmaKiwi(html: string): Promise<{
  meta: FigmaMeta;
  defs: TypeDef[];
  allChanges: KiwiValue[];
  selected: KiwiValue[];
  selectedMap: Map<string, KiwiValue>;
  blobs: Uint8Array[];
} | null> {
  if (!html.includes("(figmeta)") || !html.includes("(figma)")) return null;

  const metaB64 = extractBase64(html, "<!--(figmeta)", "(/figmeta)-->");
  if (!metaB64) return null;
  let meta: FigmaMeta;
  try {
    meta = JSON.parse(atob(metaB64)) as FigmaMeta;
  } catch {
    return null;
  }

  const selectedGuids = new Set(
    meta.selectedNodeData.split(",").map((e) => e.split("|")[0]),
  );

  const figmaB64 = extractBase64(html, "<!--(figma)", "(/figma)-->");
  if (!figmaB64) return null;
  const raw = b64ToBytes(figmaB64);
  if (String.fromCharCode(...raw.slice(0, 8)) !== "fig-kiwi") return null;

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const schemaSize = dv.getUint32(12, true);
  const dataOffset = 16 + schemaSize;
  const dataSize = dv.getUint32(dataOffset, true);

  let schemaBytes: Uint8Array;
  let dataBytes: Uint8Array;
  try {
    [schemaBytes, dataBytes] = await Promise.all([
      decompress(raw.slice(16, 16 + schemaSize), "deflate-raw"),
      decompressZstd(raw.slice(dataOffset + 4, dataOffset + 4 + dataSize)),
    ]);
  } catch {
    return null;
  }

  const defs = decodeBinarySchema(schemaBytes);
  const schemaIndex = new Map(defs.map((d) => [d.name, d]));

  let msg: KiwiValue;
  try {
    msg = decodeMessage(new ByteBuffer(dataBytes), "Message", schemaIndex);
  } catch {
    return null;
  }

  const allChanges = (msg.nodeChanges as KiwiValue[] | undefined) ?? [];
  const selected = allChanges.filter((n) => {
    const k = nodeGuidKey(n);
    return k !== null && selectedGuids.has(k);
  });
  const selectedMap = new Map(selected.map((n) => [nodeGuidKey(n)!, n]));

  // Blob pool — each blob is a struct { bytes: byte[] }. VECTOR nodes index
  // into this pool via vectorData.vectorNetworkBlob.
  const rawBlobs = (msg.blobs as KiwiValue[] | undefined) ?? [];
  const blobs = rawBlobs.map((b) =>
    Uint8Array.from((b.bytes as number[] | undefined) ?? []),
  );

  return { meta, defs, allChanges, selected, selectedMap, blobs };
}

// ---------------------------------------------------------------------------
// Vector network decoding (path geometry for VECTOR / shape nodes)
// ---------------------------------------------------------------------------

interface VNVertex {
  x: number;
  y: number;
}
interface VNSegment {
  start: number;
  tanStart: { x: number; y: number };
  end: number;
  tanEnd: { x: number; y: number };
}
interface VectorNetwork {
  vertices: VNVertex[];
  segments: VNSegment[];
}

/**
 * Decodes a Figma vector-network blob.
 *
 * Layout (all little-endian, word = 4 bytes):
 *   word 0   vertexCount  (uint32)
 *   word 1   segmentCount (uint32)
 *   word 2   regionCount  (uint32)
 *   word 3   reserved
 *   then vertexCount × 3 words:  x (f32), y (f32), styleId (uint32)
 *   then segmentCount × 7 words: start (uint32), tanStart.x/y (f32),
 *                                end (uint32), tanEnd.x/y (f32), flags
 * The final word of the last segment may be truncated; reads past the end
 * return 0 (tangents default to zero / straight lines).
 */
function decodeVectorNetwork(bytes: Uint8Array): VectorNetwork | null {
  if (bytes.length < 16) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (w: number) => (w * 4 + 4 <= bytes.length ? dv.getUint32(w * 4, true) : 0);
  const f32 = (w: number) => (w * 4 + 4 <= bytes.length ? dv.getFloat32(w * 4, true) : 0);

  const vertexCount = u32(0);
  const segmentCount = u32(1);
  if (vertexCount <= 0 || vertexCount > 100000) return null;
  if (segmentCount < 0 || segmentCount > 100000) return null;

  let w = 4;
  const vertices: VNVertex[] = [];
  for (let i = 0; i < vertexCount; i++) {
    vertices.push({ x: f32(w), y: f32(w + 1) });
    w += 3;
  }
  const segments: VNSegment[] = [];
  for (let i = 0; i < segmentCount; i++) {
    segments.push({
      start: u32(w),
      tanStart: { x: f32(w + 1), y: f32(w + 2) },
      end: u32(w + 3),
      tanEnd: { x: f32(w + 4), y: f32(w + 5) },
    });
    w += 7;
  }
  return { vertices, segments };
}

/** Trace segments into ordered closed loops (handles multiple loops). */
function traceLoops(vn: VectorNetwork): number[][] {
  const { segments } = vn;
  const usedFrom = new Set<number>(); // segment indices already consumed
  // vertex -> list of { segIdx, to }
  const adj = new Map<number, { segIdx: number; to: number }[]>();
  segments.forEach((s, i) => {
    if (!adj.has(s.start)) adj.set(s.start, []);
    adj.get(s.start)!.push({ segIdx: i, to: s.end });
  });

  const loops: number[][] = [];
  for (let i = 0; i < segments.length; i++) {
    if (usedFrom.has(i)) continue;
    const loop: number[] = [];
    let segIdx: number | undefined = i;
    const loopStart = segments[i].start;
    while (segIdx !== undefined && !usedFrom.has(segIdx)) {
      usedFrom.add(segIdx);
      const seg: VNSegment = segments[segIdx];
      loop.push(seg.start);
      const next = (adj.get(seg.end) ?? []).find(
        (e: { segIdx: number; to: number }) => !usedFrom.has(e.segIdx),
      );
      segIdx = seg.end === loopStart ? undefined : next?.segIdx;
    }
    if (loop.length >= 2) loops.push(loop);
  }
  return loops;
}

/**
 * Builds an SVG path `d` string from a vector network, in the node's local
 * coordinate space. Straight-line corners are rounded by `cornerRadius`
 * (matching Figma's corner smoothing); segments with tangents are emitted as
 * cubic béziers with no extra rounding.
 */
function vectorNetworkToPath(
  vn: VectorNetwork,
  cornerRadius: number,
  fmt: (n: number) => string,
): string {
  const { vertices, segments } = vn;
  const segByPair = new Map<string, VNSegment>();
  for (const s of segments) {
    segByPair.set(`${s.start}>${s.end}`, s);
    segByPair.set(`${s.end}>${s.start}`, s);
  }
  const hasTangent = (s: VNSegment | undefined) =>
    !!s &&
    (s.tanStart.x !== 0 || s.tanStart.y !== 0 || s.tanEnd.x !== 0 || s.tanEnd.y !== 0);

  const loops = traceLoops(vn);
  if (loops.length === 0) return "";

  const parts: string[] = [];
  for (const loop of loops) {
    const n = loop.length;
    if (n < 2) continue;
    const pts = loop.map((vi) => vertices[vi]);

    // If any segment in this loop carries tangents, emit exact béziers/lines.
    const anyCurve = loop.some((vi, i) => {
      const a = loop[i];
      const b = loop[(i + 1) % n];
      return hasTangent(segByPair.get(`${a}>${b}`));
    });

    if (anyCurve || cornerRadius <= 0) {
      let d = `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
      for (let i = 0; i < n; i++) {
        const aIdx = loop[i];
        const bIdx = loop[(i + 1) % n];
        const a = vertices[aIdx];
        const b = vertices[bIdx];
        const seg = segByPair.get(`${aIdx}>${bIdx}`);
        if (hasTangent(seg)) {
          // Tangents are relative to their vertices; orient to travel a→b.
          const forward = seg!.start === aIdx;
          const ts = forward ? seg!.tanStart : seg!.tanEnd;
          const te = forward ? seg!.tanEnd : seg!.tanStart;
          const c1x = a.x + ts.x;
          const c1y = a.y + ts.y;
          const c2x = b.x + te.x;
          const c2y = b.y + te.y;
          d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(b.x)} ${fmt(b.y)}`;
        } else {
          d += `L${fmt(b.x)} ${fmt(b.y)}`;
        }
      }
      parts.push(d + "Z");
      continue;
    }

    // All-straight loop → rounded polygon.
    const corners = pts.map((v, i) => {
      const prev = pts[(i - 1 + n) % n];
      const next = pts[(i + 1) % n];
      const inDx = v.x - prev.x;
      const inDy = v.y - prev.y;
      const outDx = next.x - v.x;
      const outDy = next.y - v.y;
      const inLen = Math.hypot(inDx, inDy) || 1;
      const outLen = Math.hypot(outDx, outDy) || 1;
      const ax = -inDx / inLen;
      const ay = -inDy / inLen;
      const bx = outDx / outLen;
      const by = outDy / outLen;
      let cosA = ax * bx + ay * by;
      cosA = Math.max(-1, Math.min(1, cosA));
      const ang = Math.acos(cosA);
      const half = ang / 2;
      let dist = half > 1e-4 ? cornerRadius / Math.tan(half) : 0;
      dist = Math.min(dist, inLen / 2, outLen / 2);
      const rEff = dist * Math.tan(half);
      const cross = inDx * outDy - inDy * outDx;
      return {
        t1: { x: v.x + ax * dist, y: v.y + ay * dist },
        t2: { x: v.x + bx * dist, y: v.y + by * dist },
        rEff,
        sweep: cross < 0 ? 1 : 0,
      };
    });
    let d = `M${fmt(corners[0].t1.x)} ${fmt(corners[0].t1.y)}`;
    for (let i = 0; i < n; i++) {
      const c = corners[i];
      const nx = corners[(i + 1) % n];
      if (c.rEff > 0.01) {
        d += `A${fmt(c.rEff)} ${fmt(c.rEff)} 0 0 ${c.sweep} ${fmt(c.t2.x)} ${fmt(c.t2.y)}`;
      }
      d += `L${fmt(nx.t1.x)} ${fmt(nx.t1.y)}`;
    }
    parts.push(d + "Z");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// parseFigmaClipboard — flat list of canvas-relevant shapes
// ---------------------------------------------------------------------------

/** Parse Figma clipboard HTML. Returns null if not Figma clipboard data. */
export async function parseFigmaClipboard(
  html: string,
): Promise<{ meta: FigmaMeta; nodes: FigmaNode[] } | null> {
  const decoded = await decodeFigmaKiwi(html);
  if (!decoded) return null;

  const { meta, defs, selected, selectedMap } = decoded;

  // Root nodes: selected nodes whose parent is not also selected
  const rootNodes = selected.filter((n) => {
    const pi = n.parentIndex as KiwiValue | undefined;
    if (!pi?.guid) return true;
    const pg = pi.guid as KiwiValue;
    return !selectedMap.has(`${pg.sessionID}:${pg.localID}`);
  });

  const nodes: FigmaNode[] = [];
  for (const n of rootNodes) {
    const transform = n.transform as KiwiValue | undefined;
    const size = n.size as KiwiValue | undefined;
    if (!transform || !size) continue;

    const x = transform.m02 as number;
    const y = transform.m12 as number;
    const w = size.x as number;
    const h = size.y as number;
    if (w <= 0 || h <= 0) continue;

    const fills = (n.fillPaints as KiwiValue[] | undefined) ?? [];
    const solidFill = fills.find((p) => {
      const typeStr = enumName(defs, "PaintType", p.type as number);
      return typeStr === "SOLID" && p.visible !== false;
    });
    const fillColor = solidFill?.color as KiwiValue | undefined;
    const fill = fillColor
      ? toHex(fillColor.r as number, fillColor.g as number, fillColor.b as number)
      : undefined;

    const textData = n.textData as KiwiValue | undefined;
    const text = textData?.characters as string | undefined;
    const type = enumName(defs, "NodeType", n.type as number);

    nodes.push({
      type,
      name: (n.name as string | undefined) ?? "",
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(w),
      height: Math.round(h),
      fill,
      text,
    });
  }

  return { meta, nodes };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

/** One rendered top-level node: a self-contained SVG plus its world-space box. */
export interface FigmaFrame {
  svg: string;
  name: string;
  /** Figma canvas (world) coordinates of the node's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RenderContext {
  defs: TypeDef[];
  blobs: Uint8Array[];
  /** parent guid-key → children, in paint order. */
  childrenOf: Map<string, KiwiValue[]>;
  f: (n: number) => string;
}

function buildRenderContext(decoded: {
  defs: TypeDef[];
  allChanges: KiwiValue[];
  blobs: Uint8Array[];
}): RenderContext {
  const { defs, allChanges, blobs } = decoded;
  // Build parent → sorted-children from ALL changes (not just selected).
  // Selected nodes are only the roots of what was copied; their descendants
  // live in allChanges but are not in selectedGuids.
  const nodeOrder = new Map(allChanges.map((n, i) => [nodeGuidKey(n)!, i]));
  const childrenOf = new Map<string, KiwiValue[]>();
  for (const n of allChanges) {
    const pi = n.parentIndex as KiwiValue | undefined;
    if (!pi?.guid) continue;
    const pk = `${(pi.guid as KiwiValue).sessionID}:${(pi.guid as KiwiValue).localID}`;
    if (!childrenOf.has(pk)) childrenOf.set(pk, []);
    childrenOf.get(pk)!.push(n);
  }
  for (const kids of childrenOf.values()) {
    kids.sort(
      (a, b) =>
        (nodeOrder.get(nodeGuidKey(a)!) ?? 0) - (nodeOrder.get(nodeGuidKey(b)!) ?? 0),
    );
  }
  const f = (n: number) => parseFloat(n.toFixed(3)).toString();
  return { defs, blobs, childrenOf, f };
}

function solidColorOf(
  paints: KiwiValue[] | undefined,
  defs: TypeDef[],
): { hex: string; opacity: number } | null {
  if (!paints?.length) return null;
  const p = paints.find(
    (p) =>
      enumName(defs, "PaintType", p.type as number) === "SOLID" && p.visible !== false,
  );
  if (!p?.color) return null;
  const c = p.color as KiwiValue;
  return {
    hex: toHex(c.r as number, c.g as number, c.b as number),
    opacity: (p.opacity as number) ?? 1,
  };
}

/**
 * Recursive hierarchical renderer.
 * rootOffsetX/Y: subtract from translation to normalize to viewBox origin.
 * For root nodes pass the root's world translation. For children pass (0, 0)
 * because their transforms are already in parent-local space.
 * `counter.n` accumulates nodes that drew ink — image/video fills reference
 * bytes that live on Figma's servers (not the clipboard), so they draw nothing.
 */
function renderNode(
  n: KiwiValue,
  rootOffsetX: number,
  rootOffsetY: number,
  ctx: RenderContext,
  counter: { n: number },
): string {
  const { defs, blobs, childrenOf, f } = ctx;
  const t = n.transform as KiwiValue | undefined;
  const s = n.size as KiwiValue | undefined;
  if (!t || !s) return "";

  const w = s.x as number;
  const h = s.y as number;
  if (w <= 0 || h <= 0) return "";

  const m00 = (t.m00 as number) ?? 1;
  const m01 = (t.m01 as number) ?? 0;
  const m10 = (t.m10 as number) ?? 0;
  const m11 = (t.m11 as number) ?? 1;
  const tx = (t.m02 as number) - rootOffsetX;
  const ty = (t.m12 as number) - rootOffsetY;

  const isIdentity =
    Math.abs(m00 - 1) < 0.001 &&
    Math.abs(m01) < 0.001 &&
    Math.abs(m10) < 0.001 &&
    Math.abs(m11 - 1) < 0.001;
  const transform = isIdentity
    ? `translate(${f(tx)},${f(ty)})`
    : `matrix(${f(m00)},${f(m10)},${f(m01)},${f(m11)},${f(tx)},${f(ty)})`;

  const type = enumName(defs, "NodeType", n.type as number);
  const fill = solidColorOf(n.fillPaints as KiwiValue[] | undefined, defs);
  const stroke = solidColorOf(n.strokePaints as KiwiValue[] | undefined, defs);
  const strokeW = (n.strokeWeight as number) || 0;
  const nodeOpacity = (n.opacity as number) ?? 1;
  const opacityAttr = nodeOpacity < 0.999 ? ` opacity="${f(nodeOpacity)}"` : "";

  const fillAttr = fill
    ? `fill="${fill.hex}" fill-opacity="${f(fill.opacity)}"`
    : `fill="none"`;
  const strokeAttr =
    stroke && strokeW > 0 ? ` stroke="${stroke.hex}" stroke-width="${f(strokeW)}"` : "";

  // Children are in parent-local space, so pass offsets of 0
  const k = nodeGuidKey(n);
  const kids = k ? (childrenOf.get(k) ?? []) : [];
  const childSVG = kids.map((c) => renderNode(c, 0, 0, ctx, counter)).join("");

  switch (type) {
    case "RECTANGLE":
    case "ROUNDED_RECTANGLE": {
      const rx = (n.cornerRadius as number) || 0;
      const rxAttr = rx > 0 ? ` rx="${f(rx)}"` : "";
      if (fill || (stroke && strokeW > 0)) counter.n++;
      return (
        `<g transform="${transform}"${opacityAttr}>` +
        `<rect width="${f(w)}" height="${f(h)}"${rxAttr} ${fillAttr}${strokeAttr}/>` +
        childSVG +
        `</g>`
      );
    }
    case "ELLIPSE":
      if (fill || (stroke && strokeW > 0)) counter.n++;
      return (
        `<g transform="${transform}"${opacityAttr}>` +
        `<ellipse cx="${f(w / 2)}" cy="${f(h / 2)}" rx="${f(w / 2)}" ry="${f(h / 2)}" ${fillAttr}${strokeAttr}/>` +
        childSVG +
        `</g>`
      );
    case "TEXT": {
      const textData = n.textData as KiwiValue | undefined;
      const chars = (textData?.characters as string | undefined) ?? "";
      const fontSize = (textData?.fontSize as number | undefined) ?? 14;
      const textFill = fill ? fill.hex : "#000000";
      if (chars.trim().length > 0) counter.n++;
      const tspans = chars
        .split("\n")
        .map((l, i) => {
          const esc = l
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
          return `<tspan x="0" dy="${i === 0 ? 0 : f(fontSize * 1.2)}">${esc || " "}</tspan>`;
        })
        .join("");
      return (
        `<g transform="${transform}"${opacityAttr}>` +
        `<text font-size="${f(fontSize)}" fill="${textFill}" dominant-baseline="text-before-edge">${tspans}</text>` +
        childSVG +
        `</g>`
      );
    }
    case "FRAME":
    case "COMPONENT":
    case "INSTANCE":
    case "GROUP":
    case "COMPONENT_SET":
    case "SECTION":
      // Containers: transparent background, just wrap children
      return childSVG ? `<g transform="${transform}"${opacityAttr}>${childSVG}</g>` : "";
    default: {
      // VECTOR, LINE, BOOLEAN_OPERATION, STAR, REGULAR_POLYGON, etc.
      // Real path geometry lives in the blob pool, referenced by
      // vectorData.vectorNetworkBlob. Decode it into an SVG path.
      const vectorData = n.vectorData as KiwiValue | undefined;
      const blobIdx = vectorData?.vectorNetworkBlob as number | undefined;
      if ((fill || (stroke && strokeW > 0)) && blobIdx !== undefined && blobs[blobIdx]) {
        const vn = decodeVectorNetwork(blobs[blobIdx]);
        // Vertices are stored in the vector's normalizedSize space; scale them
        // to the node's actual rendered size (Figma scales the network to fit).
        const norm = vectorData?.normalizedSize as KiwiValue | undefined;
        const sx = norm && (norm.x as number) ? w / (norm.x as number) : 1;
        const sy = norm && (norm.y as number) ? h / (norm.y as number) : 1;
        const scaled =
          vn && (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6)
            ? {
                vertices: vn.vertices.map((v) => ({ x: v.x * sx, y: v.y * sy })),
                segments: vn.segments.map((s) => ({
                  start: s.start,
                  end: s.end,
                  tanStart: { x: s.tanStart.x * sx, y: s.tanStart.y * sy },
                  tanEnd: { x: s.tanEnd.x * sx, y: s.tanEnd.y * sy },
                })),
              }
            : vn;
        const d = scaled
          ? vectorNetworkToPath(scaled, (n.cornerRadius as number) || 0, f)
          : "";
        if (d) {
          counter.n++;
          return (
            `<g transform="${transform}"${opacityAttr}>` +
            `<path d="${d}" ${fillAttr}${strokeAttr}/>` +
            childSVG +
            `</g>`
          );
        }
      }
      // Fallback: approximate with the bounding rect.
      if (fill || (stroke && strokeW > 0)) {
        counter.n++;
        return (
          `<g transform="${transform}"${opacityAttr}>` +
          `<rect width="${f(w)}" height="${f(h)}" ${fillAttr}${strokeAttr}/>` +
          childSVG +
          `</g>`
        );
      }
      return childSVG ? `<g transform="${transform}">${childSVG}</g>` : "";
    }
  }
}

/** Renders one node-subtree to a self-contained SVG sized to that node. */
function renderRoot(
  root: KiwiValue,
  ctx: RenderContext,
): { svg: string; width: number; height: number } | null {
  const t = root.transform as KiwiValue | undefined;
  const s = root.size as KiwiValue | undefined;
  if (!t || !s) return null;
  const width = s.x as number;
  const height = s.y as number;
  const x = t.m02 as number;
  const y = t.m12 as number;
  if (!isFinite(x) || !isFinite(y) || width <= 0 || height <= 0) return null;

  const counter = { n: 0 };
  // Offset by the root's own world translation so its <g> sits at (0,0).
  const body = renderNode(root, x, y, ctx, counter);
  if (counter.n === 0) return null;

  const vw = Math.round(width);
  const vh = Math.round(height);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">\n` +
    body +
    `\n</svg>`;
  return { svg, width, height };
}

/**
 * Decodes a Figma clipboard and renders each selected top-level node as its
 * own SVG, tagged with the node's world-space box so the caller can lay the
 * shapes out preserving their relative positions. Returns null if nothing in
 * the selection is renderable (e.g. a pure image selection).
 */
export async function figmaClipboardToFrames(html: string): Promise<FigmaFrame[] | null> {
  const decoded = await decodeFigmaKiwi(html);
  if (!decoded) return null;
  const ctx = buildRenderContext(decoded);

  const frames: FigmaFrame[] = [];
  for (const root of decoded.selected) {
    const rendered = renderRoot(root, ctx);
    if (!rendered) continue;
    const t = root.transform as KiwiValue;
    frames.push({
      svg: rendered.svg,
      name: (root.name as string | undefined) ?? "",
      x: t.m02 as number,
      y: t.m12 as number,
      width: rendered.width,
      height: rendered.height,
    });
  }
  return frames.length ? frames : null;
}

/**
 * Decodes a Figma clipboard and renders the whole selection into a single SVG
 * (its world-space bounding box). Returns null if nothing is renderable.
 */
export async function figmaClipboardToSVG(html: string): Promise<string | null> {
  const decoded = await decodeFigmaKiwi(html);
  if (!decoded) return null;
  const ctx = buildRenderContext(decoded);
  const roots = decoded.selected;

  // ViewBox from selected roots (world-space bounding box).
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of roots) {
    const t = n.transform as KiwiValue | undefined;
    const s = n.size as KiwiValue | undefined;
    if (!t || !s) continue;
    const x = t.m02 as number,
      y = t.m12 as number;
    const w = s.x as number,
      h = s.y as number;
    if (!isFinite(x) || !isFinite(y) || w <= 0 || h <= 0) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  if (!isFinite(minX)) return null;

  const vw = Math.round(maxX - minX);
  const vh = Math.round(maxY - minY);
  const counter = { n: 0 };
  const body = roots.map((n) => renderNode(n, minX, minY, ctx, counter)).join("\n");

  if (counter.n === 0) return null;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">\n` +
    body +
    `\n</svg>`
  );
}
