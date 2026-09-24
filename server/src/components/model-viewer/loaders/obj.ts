// Wavefront OBJ → Mesh. Supports v/vn positions+normals and polygon faces
// (triangulated by a simple fan). Texture coords are parsed for indexing but
// discarded — the preview is untextured. Faces without normals fall back to
// computed ones.

import { computeNormals, type Mesh, mergeMeshes } from "#components/model-viewer/mesh.ts";

function parseFaceIndex(token: string, count: number): number {
  const raw = Number.parseInt(token, 10);
  if (!Number.isInteger(raw) || raw === 0) return -1;
  return raw < 0 ? count + raw : raw - 1;
}

export function parseObj(text: string): Mesh {
  const positions: number[] = [];
  const normals: number[] = [];

  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outIndices: number[] = [];
  let hasNormals = true;
  // Dedup identical v//vn vertex tuples so shared vertices are not duplicated.
  const vertexMap = new Map<string, number>();

  const addVertex = (posIdx: number, normIdx: number): number => {
    const key = `${posIdx}/${normIdx}`;
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const index = outPositions.length / 3;
    outPositions.push(
      positions[posIdx * 3] ?? 0,
      positions[posIdx * 3 + 1] ?? 0,
      positions[posIdx * 3 + 2] ?? 0,
    );
    if (normIdx >= 0 && normals.length > 0) {
      outNormals.push(
        normals[normIdx * 3] ?? 0,
        normals[normIdx * 3 + 1] ?? 0,
        normals[normIdx * 3 + 2] ?? 0,
      );
    } else {
      hasNormals = false;
      outNormals.push(0, 0, 0);
    }
    vertexMap.set(key, index);
    return index;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const kind = parts[0];

    if (kind === "v") {
      positions.push(Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0);
    } else if (kind === "vn") {
      normals.push(Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0);
    } else if (kind === "f") {
      const faceVerts: number[] = [];
      const posCount = positions.length / 3;
      const normCount = normals.length / 3;
      for (let i = 1; i < parts.length; i += 1) {
        const [posTok, , normTok] = parts[i].split("/");
        const posIdx = parseFaceIndex(posTok ?? "", posCount);
        if (posIdx < 0) continue;
        const normIdx = normTok ? parseFaceIndex(normTok, normCount) : -1;
        faceVerts.push(addVertex(posIdx, normIdx));
      }
      // Fan-triangulate the polygon.
      for (let i = 1; i + 1 < faceVerts.length; i += 1) {
        outIndices.push(faceVerts[0], faceVerts[i], faceVerts[i + 1]);
      }
    }
  }

  const positionArray = new Float32Array(outPositions);
  const indexArray = new Uint32Array(outIndices);
  const normalArray = hasNormals
    ? new Float32Array(outNormals)
    : computeNormals(positionArray, indexArray);

  return mergeMeshes([
    { positions: positionArray, normals: normalArray, indices: indexArray },
  ]);
}
