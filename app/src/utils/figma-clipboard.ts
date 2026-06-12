/**
 * Parses Figma clipboard HTML (fig-kiwi binary format) into a flat list of
 * canvas-relevant node descriptors.
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
 * The kiwi-schema package bundled with fig-kiwi only knows 6 primitive types;
 * Figma uses int64 (index -7) and uint64 (index -8) as well. We remap those to
 * int/uint (JS has no native 64-bit integers, but the values we care about —
 * positions, sizes, field IDs — are well within 32-bit range).
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

// Primitive type indices (kiwi uses ~index as a negative varint)
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
// HTML parsing + full decode pipeline
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

// ---------------------------------------------------------------------------
// Decompression — native DecompressionStream where available, fzstd fallback
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

/** Parse Figma clipboard HTML. Returns null if not Figma clipboard data. */
export async function parseFigmaClipboard(
  html: string,
): Promise<{ meta: FigmaMeta; nodes: FigmaNode[] } | null> {
  if (!html.includes("(figmeta)") || !html.includes("(figma)")) return null;

  // --- meta ---
  const metaB64 = extractBase64(html, "<!--(figmeta)", "(/figmeta)-->");
  if (!metaB64) return null;
  let meta: FigmaMeta;
  try {
    meta = JSON.parse(atob(metaB64)) as FigmaMeta;
  } catch {
    return null;
  }

  // --- binary buffer ---
  const figmaB64 = extractBase64(html, "<!--(figma)", "(/figma)-->");
  if (!figmaB64) return null;
  const raw = b64ToBytes(figmaB64);

  // Check magic
  const magic = String.fromCharCode(...raw.slice(0, 8));
  if (magic !== "fig-kiwi") return null;

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const schemaSize = dv.getUint32(12, true);
  const schemaCompressed = raw.slice(16, 16 + schemaSize);
  const dataOffset = 16 + schemaSize;
  const dataSize = dv.getUint32(dataOffset, true);
  const dataCompressed = raw.slice(dataOffset + 4, dataOffset + 4 + dataSize);

  // Schema: deflate-raw (native DecompressionStream, available everywhere)
  // Data:   zstd (native in Chrome 123+, fzstd fallback for Firefox/Safari)
  let schemaBytes: Uint8Array;
  let dataBytes: Uint8Array;
  try {
    [schemaBytes, dataBytes] = await Promise.all([
      decompress(schemaCompressed, "deflate-raw"),
      decompressZstd(dataCompressed),
    ]);
  } catch {
    return null;
  }

  // Decode schema
  const defs = decodeBinarySchema(schemaBytes);
  const schemaIndex = new Map(defs.map((d) => [d.name, d]));

  // Decode message
  let msg: KiwiValue;
  try {
    msg = decodeMessage(new ByteBuffer(dataBytes), "Message", schemaIndex);
  } catch {
    return null;
  }

  const allChanges = (msg.nodeChanges as KiwiValue[] | undefined) ?? [];

  // Build set of selected node GUIDs from figmeta
  const selectedGuids = new Set(
    meta.selectedNodeData.split(",").map((entry) => entry.split("|")[0]),
  );

  const guidKey = (n: KiwiValue): string | null => {
    const g = n.guid as KiwiValue | undefined;
    if (!g) return null;
    return `${g.sessionID}:${g.localID}`;
  };

  // Filter to selected nodes only
  const selected = allChanges.filter((n) => {
    const k = guidKey(n);
    return k !== null && selectedGuids.has(k);
  });

  // Find root nodes: selected nodes whose parent is also not in selection
  const selectedKeys = new Set(selected.map(guidKey).filter(Boolean) as string[]);
  const rootNodes = selected.filter((n) => {
    const pi = n.parentIndex as KiwiValue | undefined;
    if (!pi?.guid) return true;
    const pg = pi.guid as KiwiValue;
    return !selectedKeys.has(`${pg.sessionID}:${pg.localID}`);
  });

  // Map to FigmaNode
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
      const typeVal = p.type as number;
      const typeStr = enumName(defs, "PaintType", typeVal);
      const visible = p.visible as boolean | undefined;
      return typeStr === "SOLID" && visible !== false;
    });
    const fillColor = solidFill?.color as KiwiValue | undefined;
    const fill = fillColor
      ? toHex(fillColor.r as number, fillColor.g as number, fillColor.b as number)
      : undefined;

    const textData = n.textData as KiwiValue | undefined;
    const text = textData?.characters as string | undefined;

    const typeVal = n.type as number;
    const type = enumName(defs, "NodeType", typeVal);

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
