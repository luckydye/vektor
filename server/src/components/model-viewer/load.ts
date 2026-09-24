// Fetches a model URL and dispatches to the right loader by extension, falling
// back to content sniffing (GLB magic bytes, or a leading "{" for glTF JSON)
// when the URL carries no useful extension.

import { parseGltf } from "./loaders/gltf.ts";
import { parseObj } from "./loaders/obj.ts";
import type { Mesh } from "./mesh.ts";

export type ModelFormat = "obj" | "gltf" | "glb";

const GLB_MAGIC = 0x46546c67;

export function formatFromUrl(src: string): ModelFormat | null {
  let pathname = src;
  try {
    pathname = new URL(src, "http://x").pathname;
  } catch {
    // Keep the raw string for relative paths that URL() rejects.
  }
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "obj") return "obj";
  if (ext === "gltf") return "gltf";
  if (ext === "glb") return "glb";
  return null;
}

export async function loadMesh(src: string): Promise<Mesh> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Failed to fetch model (${response.status})`);
  const buffer = await response.arrayBuffer();

  let format = formatFromUrl(src);
  if (!format) format = sniffFormat(buffer);
  if (!format) throw new Error("Unsupported or unrecognised 3D format");

  if (format === "obj") return parseObj(new TextDecoder().decode(new Uint8Array(buffer)));
  return parseGltf(buffer, src, format === "glb");
}

function sniffFormat(buffer: ArrayBuffer): ModelFormat | null {
  if (buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, true) === GLB_MAGIC) {
    return "glb";
  }
  // Skip leading whitespace, then look for a JSON object (glTF) or OBJ tokens.
  const head = new TextDecoder().decode(
    new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength)),
  );
  const trimmed = head.trimStart();
  if (trimmed.startsWith("{")) return "gltf";
  if (/^(v|vn|vt|f|o|g|mtllib)\s/m.test(trimmed)) return "obj";
  return null;
}
