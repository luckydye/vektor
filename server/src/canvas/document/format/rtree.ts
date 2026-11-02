/**
 * A packed Hilbert R-tree, as in FlatGeobuf: leaves in Hilbert order, parents
 * built bottom-up over runs of `NODE_SIZE`, stored root-first.
 *
 * Payload: `leafCount u32 | nodeSize u16`, then the internal levels from the
 * root down (4×f32 bbox, u64 index of the first child entry in the level
 * below), then the leaves (4×f32 bbox, u64 record offset, u64 Hilbert key).
 */

import {
  type BBox,
  ByteReader,
  ByteWriter,
  outwardBBox,
} from "#canvas/document/format/records.ts";

export const NODE_SIZE = 16;

export interface IndexLeaf {
  bbox: BBox;
  offset: number;
  key: bigint;
}

export interface PackedRTree {
  nodeSize: number;
  /** `levels[0]` are the leaves; each holds 4 floats per entry. */
  levels: Float32Array[];
  /** Per internal level, the first child entry of each entry; `children[0]` is unused. */
  children: Float64Array[];
  offsets: Float64Array;
  keys: BigUint64Array;
}

function levelSizes(leafCount: number, nodeSize: number): number[] {
  const sizes = [leafCount];
  while (sizes[sizes.length - 1] > 1) {
    sizes.push(Math.ceil(sizes[sizes.length - 1] / nodeSize));
  }
  return sizes;
}

/** Builds the tree over leaves already in Hilbert order. */
export function buildRTree(
  leaves: readonly IndexLeaf[],
  nodeSize = NODE_SIZE,
): PackedRTree {
  const sizes = levelSizes(leaves.length, nodeSize);
  const leafBoxes = new Float32Array(leaves.length * 4);
  const offsets = new Float64Array(leaves.length);
  const keys = new BigUint64Array(leaves.length);
  leaves.forEach((leaf, i) => {
    leafBoxes.set(outwardBBox(leaf.bbox), i * 4);
    offsets[i] = leaf.offset;
    keys[i] = leaf.key;
  });
  const levels = [leafBoxes];
  const children = [new Float64Array(0)];
  for (let level = 1; level < sizes.length; level++) {
    const below = levels[level - 1];
    const boxes = new Float32Array(sizes[level] * 4);
    const firsts = new Float64Array(sizes[level]);
    for (let i = 0; i < sizes[level]; i++) {
      const first = i * nodeSize;
      const last = Math.min(first + nodeSize, sizes[level - 1]);
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (let j = first; j < last; j++) {
        x0 = Math.min(x0, below[j * 4]);
        y0 = Math.min(y0, below[j * 4 + 1]);
        x1 = Math.max(x1, below[j * 4 + 2]);
        y1 = Math.max(y1, below[j * 4 + 3]);
      }
      boxes.set([x0, y0, x1, y1], i * 4);
      firsts[i] = first;
    }
    levels.push(boxes);
    children.push(firsts);
  }
  return { nodeSize, levels, children, offsets, keys };
}

export function encodeRTree(tree: PackedRTree): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(tree.offsets.length);
  writer.ensure(2);
  writer.view.setUint16(writer.length, tree.nodeSize, true);
  writer.length += 2;
  for (let level = tree.levels.length - 1; level >= 1; level--) {
    const boxes = tree.levels[level];
    for (let i = 0; i < boxes.length / 4; i++) {
      for (let k = 0; k < 4; k++) writer.f32(boxes[i * 4 + k]);
      writer.u64(tree.children[level][i]);
    }
  }
  const leaves = tree.levels[0];
  for (let i = 0; i < tree.offsets.length; i++) {
    for (let k = 0; k < 4; k++) writer.f32(leaves[i * 4 + k]);
    writer.u64(tree.offsets[i]);
    writer.bigU64(tree.keys[i]);
  }
  return writer.finish();
}

export function decodeRTree(payload: Uint8Array): PackedRTree {
  const reader = new ByteReader(payload);
  const leafCount = reader.u32();
  reader.need(2);
  const nodeSize = reader.view.getUint16(reader.offset, true);
  reader.offset += 2;
  const sizes = levelSizes(leafCount, nodeSize);
  const levels: Float32Array[] = new Array(sizes.length);
  const children: Float64Array[] = new Array(sizes.length);
  children[0] = new Float64Array(0);
  for (let level = sizes.length - 1; level >= 1; level--) {
    const boxes = new Float32Array(sizes[level] * 4);
    const firsts = new Float64Array(sizes[level]);
    for (let i = 0; i < sizes[level]; i++) {
      for (let k = 0; k < 4; k++) boxes[i * 4 + k] = reader.f32();
      firsts[i] = reader.u64();
    }
    levels[level] = boxes;
    children[level] = firsts;
  }
  const leaves = new Float32Array(leafCount * 4);
  const offsets = new Float64Array(leafCount);
  const keys = new BigUint64Array(leafCount);
  for (let i = 0; i < leafCount; i++) {
    for (let k = 0; k < 4; k++) leaves[i * 4 + k] = reader.f32();
    offsets[i] = reader.u64();
    keys[i] = reader.bigU64();
  }
  levels[0] = leaves;
  return { nodeSize, levels, children, offsets, keys };
}

function intersects(boxes: Float32Array, i: number, rect: BBox): boolean {
  return (
    boxes[i * 4] <= rect[2] &&
    boxes[i * 4 + 2] >= rect[0] &&
    boxes[i * 4 + 1] <= rect[3] &&
    boxes[i * 4 + 3] >= rect[1]
  );
}

/** Leaf indices whose bbox intersects `rect`, in file order. */
export function queryRTree(tree: PackedRTree, rect: BBox): number[] {
  const leafCount = tree.offsets.length;
  if (leafCount === 0) return [];
  const top = tree.levels.length - 1;
  const found: number[] = [];
  const stack: [number, number][] = [[top, 0]];
  while (stack.length > 0) {
    const [level, index] = stack.pop() as [number, number];
    if (!intersects(tree.levels[level], index, rect)) continue;
    if (level === 0) {
      found.push(index);
      continue;
    }
    const first = tree.children[level][index];
    const last = Math.min(first + tree.nodeSize, tree.levels[level - 1].length / 4);
    for (let child = last - 1; child >= first; child--) stack.push([level - 1, child]);
  }
  return found.sort((a, b) => a - b);
}

export function leafBBox(tree: PackedRTree, index: number): BBox {
  const boxes = tree.levels[0];
  return [
    boxes[index * 4],
    boxes[index * 4 + 1],
    boxes[index * 4 + 2],
    boxes[index * 4 + 3],
  ];
}
