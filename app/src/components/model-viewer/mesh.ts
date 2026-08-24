// A renderer-ready mesh: interleaved-free parallel arrays plus the axis-aligned
// bounds used to frame the camera. All loaders (OBJ, glTF, GLB) normalise into
// this single shape so the WebGPU renderer only ever sees one thing.

export type Mesh = {
  positions: Float32Array; // xyz per vertex, in world space
  normals: Float32Array; // xyz per vertex, unit length
  indices: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
};

// Derives flat-ish per-vertex normals from face geometry, used when a source
// file omits them (common for OBJ and some glTF primitives). Accumulates each
// triangle's face normal onto its vertices, then normalises.
export function computeNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ax = positions[a];
    const ay = positions[a + 1];
    const az = positions[a + 2];
    const e1x = positions[b] - ax;
    const e1y = positions[b + 1] - ay;
    const e1z = positions[b + 2] - az;
    const e2x = positions[c] - ax;
    const e2y = positions[c + 1] - ay;
    const e2z = positions[c + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const idx of [a, b, c]) {
      normals[idx] += nx;
      normals[idx + 1] += ny;
      normals[idx + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

// Combines several primitives (each already in world space) into one mesh with
// a single index buffer, offsetting indices as buffers are concatenated.
export function mergeMeshes(parts: Array<Omit<Mesh, "min" | "max">>): Mesh {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of parts) {
    vertexCount += part.positions.length / 3;
    indexCount += part.indices.length;
  }

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of parts) {
    positions.set(part.positions, vertexOffset * 3);
    normals.set(part.normals, vertexOffset * 3);
    for (let i = 0; i < part.indices.length; i += 1) {
      indices[indexOffset + i] = part.indices[i] + vertexOffset;
    }
    for (let i = 0; i < part.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = part.positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    vertexOffset += part.positions.length / 3;
    indexOffset += part.indices.length;
  }

  return { positions, normals, indices, min, max };
}
