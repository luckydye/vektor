// glTF 2.0 / GLB → Mesh. Deliberately small: reads the default scene, walks the
// node graph accumulating world transforms, and pulls POSITION / NORMAL / index
// accessors from each mesh primitive into world space. Materials, textures,
// animation, skinning, sparse accessors and Draco are ignored — this is a
// geometry preview, not a full renderer.

import {
  composeTRS,
  identity,
  type Mat4,
  multiply,
  transformPoint,
  type Vec3,
} from "#model-viewer/math.ts";
import { computeNormals, type Mesh, mergeMeshes } from "#model-viewer/mesh.ts";

type GltfJson = {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }>;
  meshes?: Array<{
    primitives: Array<{
      attributes: Record<string, number>;
      indices?: number;
      mode?: number;
    }>;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  buffers?: Array<{ uri?: string; byteLength: number }>;
};

const COMPONENTS_PER_TYPE: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

function parseGlb(buffer: ArrayBuffer): { json: GltfJson; bin: Uint8Array | null } {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error("Not a GLB file");
  }
  const length = view.getUint32(8, true);
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset < length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(
        new TextDecoder().decode(new Uint8Array(buffer, start, chunkLength)),
      );
    } else if (chunkType === CHUNK_BIN) {
      bin = new Uint8Array(buffer, start, chunkLength);
    }
    offset = start + chunkLength;
  }
  if (!json) throw new Error("GLB missing JSON chunk");
  return { json, bin };
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (meta.includes(";base64")) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(data));
}

async function resolveBuffers(
  json: GltfJson,
  baseUrl: string,
  glbBin: Uint8Array | null,
): Promise<Uint8Array[]> {
  const buffers = json.buffers ?? [];
  return Promise.all(
    buffers.map(async (buffer) => {
      if (!buffer.uri) {
        if (!glbBin) throw new Error("glTF buffer has no uri and no GLB binary chunk");
        return glbBin;
      }
      if (buffer.uri.startsWith("data:")) return decodeDataUri(buffer.uri);
      const url = new URL(buffer.uri, baseUrl).href;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to load buffer ${buffer.uri}`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
}

// Reads an accessor into a flat Float32Array of `count * components` values,
// honouring the buffer view's byteStride when the data is interleaved.
function readAccessor(
  json: GltfJson,
  buffers: Uint8Array[],
  accessorIndex: number,
): Float32Array {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing accessor ${accessorIndex}`);
  const components = COMPONENTS_PER_TYPE[accessor.type] ?? 1;
  const view = json.bufferViews?.[accessor.bufferView ?? -1];
  if (!view) throw new Error("Accessor without bufferView is unsupported");
  const buffer = buffers[view.buffer];
  const baseOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const componentSize = componentByteSize(accessor.componentType);
  const stride = view.byteStride ?? components * componentSize;
  const out = new Float32Array(accessor.count * components);

  for (let i = 0; i < accessor.count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      const at = baseOffset + i * stride + c * componentSize;
      out[i * components + c] = readComponent(dv, at, accessor.componentType);
    }
  }
  return out;
}

function readIndices(
  json: GltfJson,
  buffers: Uint8Array[],
  accessorIndex: number,
): Uint32Array {
  const floats = readAccessor(json, buffers, accessorIndex);
  const out = new Uint32Array(floats.length);
  for (let i = 0; i < floats.length; i += 1) out[i] = floats[i];
  return out;
}

function componentByteSize(componentType: number): number {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      throw new Error(`Unknown componentType ${componentType}`);
  }
}

function readComponent(dv: DataView, at: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return dv.getInt8(at);
    case 5121:
      return dv.getUint8(at);
    case 5122:
      return dv.getInt16(at, true);
    case 5123:
      return dv.getUint16(at, true);
    case 5125:
      return dv.getUint32(at, true);
    case 5126:
      return dv.getFloat32(at, true);
    default:
      throw new Error(`Unknown componentType ${componentType}`);
  }
}

function nodeLocalMatrix(node: NonNullable<GltfJson["nodes"]>[number]): Mat4 {
  if (node.matrix && node.matrix.length === 16) {
    return new Float32Array(node.matrix);
  }
  return composeTRS(
    node.translation ?? [0, 0, 0],
    node.rotation ?? [0, 0, 0, 1],
    node.scale ?? [1, 1, 1],
  );
}

export async function parseGltf(
  input: ArrayBuffer,
  baseUrl: string,
  isBinary: boolean,
): Promise<Mesh> {
  let json: GltfJson;
  let glbBin: Uint8Array | null = null;
  if (isBinary) {
    ({ json, bin: glbBin } = parseGlb(input));
  } else {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(input)));
  }

  const buffers = await resolveBuffers(json, baseUrl, glbBin);
  const parts: Array<Omit<Mesh, "min" | "max">> = [];
  const point: Vec3 = [0, 0, 0];

  const visit = (nodeIndex: number, parentMatrix: Mat4) => {
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const worldMatrix = multiply(parentMatrix, nodeLocalMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      for (const primitive of mesh?.primitives ?? []) {
        // Only triangles (mode 4 or default) are drawn.
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const positionIndex = primitive.attributes.POSITION;
        if (positionIndex === undefined) continue;

        const rawPositions = readAccessor(json, buffers, positionIndex);
        const positions = new Float32Array(rawPositions.length);
        for (let i = 0; i < rawPositions.length; i += 3) {
          transformPoint(
            worldMatrix,
            rawPositions[i],
            rawPositions[i + 1],
            rawPositions[i + 2],
            point,
          );
          positions[i] = point[0];
          positions[i + 1] = point[1];
          positions[i + 2] = point[2];
        }

        const vertexCount = positions.length / 3;
        const indices =
          primitive.indices !== undefined
            ? readIndices(json, buffers, primitive.indices)
            : Uint32Array.from({ length: vertexCount }, (_, i) => i);

        let normals: Float32Array;
        if (primitive.attributes.NORMAL !== undefined) {
          // Rotate normals by the world matrix's upper 3x3 (adequate for the
          // uniform/rigid transforms typical of preview assets).
          const rawNormals = readAccessor(json, buffers, primitive.attributes.NORMAL);
          normals = new Float32Array(rawNormals.length);
          for (let i = 0; i < rawNormals.length; i += 3) {
            const nx = rawNormals[i];
            const ny = rawNormals[i + 1];
            const nz = rawNormals[i + 2];
            const wx = worldMatrix[0] * nx + worldMatrix[4] * ny + worldMatrix[8] * nz;
            const wy = worldMatrix[1] * nx + worldMatrix[5] * ny + worldMatrix[9] * nz;
            const wz = worldMatrix[2] * nx + worldMatrix[6] * ny + worldMatrix[10] * nz;
            const len = Math.hypot(wx, wy, wz) || 1;
            normals[i] = wx / len;
            normals[i + 1] = wy / len;
            normals[i + 2] = wz / len;
          }
        } else {
          normals = computeNormals(positions, indices);
        }

        parts.push({ positions, normals, indices });
      }
    }

    for (const child of node.children ?? []) visit(child, worldMatrix);
  };

  const sceneIndex = json.scene ?? 0;
  const rootNodes =
    json.scenes?.[sceneIndex]?.nodes ?? json.nodes?.map((_, i) => i) ?? [];
  const root = identity();
  for (const nodeIndex of rootNodes) visit(nodeIndex, root);

  if (parts.length === 0) throw new Error("No triangle geometry found in glTF");
  return mergeMeshes(parts);
}
