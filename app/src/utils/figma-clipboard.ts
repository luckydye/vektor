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

  return { meta, defs, allChanges, selected, selectedMap };
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
      ? toHex(
          fillColor.r as number,
          fillColor.g as number,
          fillColor.b as number,
        )
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
// figmaClipboardToSVG — render entire selection as a single SVG
// ---------------------------------------------------------------------------

/**
 * Decodes a Figma clipboard and renders the selected nodes as an SVG string.
 * The full node tree is preserved (frames contain their children). Each node
 * type maps to the closest SVG primitive; VECTOR/path nodes fall back to a
 * filled rectangle since the path command data lives in a separate blob pool
 * that is not decoded here.
 */
export async function figmaClipboardToSVG(html: string): Promise<string | null> {
  const decoded = await decodeFigmaKiwi(html);
  if (!decoded) return null;

  const { defs, allChanges, selected } = decoded;

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
        (nodeOrder.get(nodeGuidKey(a)!) ?? 0) -
        (nodeOrder.get(nodeGuidKey(b)!) ?? 0),
    );
  }

  // Render roots = the explicitly selected nodes. Their transforms are in
  // Figma canvas/world space. Children are in parent-local space.
  const roots = selected;

  // ViewBox from selected roots (world-space bounding box)
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

  // Compact float formatter
  const f = (n: number) => parseFloat(n.toFixed(3)).toString();

  function solidColor(
    paints: KiwiValue[] | undefined,
  ): { hex: string; opacity: number } | null {
    if (!paints?.length) return null;
    const p = paints.find(
      (p) =>
        enumName(defs, "PaintType", p.type as number) === "SOLID" &&
        p.visible !== false,
    );
    if (!p?.color) return null;
    const c = p.color as KiwiValue;
    return {
      hex: toHex(c.r as number, c.g as number, c.b as number),
      opacity: (p.opacity as number) ?? 1,
    };
  }

  // Recursive hierarchical renderer.
  // rootOffsetX/Y: subtract from translation to normalize to viewBox origin.
  // For root nodes pass (minX, minY). For children pass (0, 0) because their
  // transforms are already in parent-local space.
  function renderNode(
    n: KiwiValue,
    rootOffsetX: number,
    rootOffsetY: number,
  ): string {
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
    const fill = solidColor(n.fillPaints as KiwiValue[] | undefined);
    const stroke = solidColor(n.strokePaints as KiwiValue[] | undefined);
    const strokeW = (n.strokeWeight as number) || 0;
    const nodeOpacity = (n.opacity as number) ?? 1;
    const opacityAttr =
      nodeOpacity < 0.999 ? ` opacity="${f(nodeOpacity)}"` : "";

    const fillAttr = fill
      ? `fill="${fill.hex}" fill-opacity="${f(fill.opacity)}"`
      : `fill="none"`;
    const strokeAttr =
      stroke && strokeW > 0
        ? ` stroke="${stroke.hex}" stroke-width="${f(strokeW)}"`
        : "";

    // Children are in parent-local space, so pass offsets of 0
    const k = nodeGuidKey(n);
    const kids = k ? (childrenOf.get(k) ?? []) : [];
    const childSVG = kids.map((c) => renderNode(c, 0, 0)).join("");

    switch (type) {
      case "RECTANGLE":
      case "ROUNDED_RECTANGLE": {
        const rx = (n.cornerRadius as number) || 0;
        const rxAttr = rx > 0 ? ` rx="${f(rx)}"` : "";
        return (
          `<g transform="${transform}"${opacityAttr}>` +
          `<rect width="${f(w)}" height="${f(h)}"${rxAttr} ${fillAttr}${strokeAttr}/>` +
          childSVG +
          `</g>`
        );
      }
      case "ELLIPSE":
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
        return childSVG
          ? `<g transform="${transform}"${opacityAttr}>${childSVG}</g>`
          : "";
      default:
        // VECTOR, LINE, BOOLEAN_OPERATION, STAR, REGULAR_POLYGON, etc.
        // Path data lives in a separate blob pool; approximate with a rect.
        if (fill || (stroke && strokeW > 0)) {
          return (
            `<g transform="${transform}"${opacityAttr}>` +
            `<rect width="${f(w)}" height="${f(h)}" ${fillAttr}${strokeAttr}/>` +
            childSVG +
            `</g>`
          );
        }
        return childSVG
          ? `<g transform="${transform}">${childSVG}</g>`
          : "";
    }
  }

  const body = roots.map((n) => renderNode(n, minX, minY)).join("\n");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}">\n` +
    body +
    `\n</svg>`
  );
}
