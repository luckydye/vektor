/**
 * The canvas as an accessibility tree: every element nested under the innermost
 * container holding it, siblings in reading order. The host renders it as the
 * canvas's fallback content, for screen readers and keyboard navigation.
 */
import type { CanvasRect } from "#canvas/runtime/extensionApi.ts";

export type CanvasAccessibleElement = {
  id: string;
  label: string;
  locked: boolean;
  /** Axis-aligned world bounds, which nesting and reading order compare. */
  bounds: CanvasRect;
  /** Set on containers: whether an element with these bounds sits inside. */
  contains: ((bounds: CanvasRect) => boolean) | null;
};

export type CanvasAccessibleNode = CanvasAccessibleElement & {
  children: CanvasAccessibleNode[];
};

const area = (rect: CanvasRect) => rect.width * rect.height;

export function buildAccessibilityTree(
  elements: readonly CanvasAccessibleElement[],
): CanvasAccessibleNode[] {
  const containers = elements.filter((element) => element.contains);
  // Strictly larger parents only, so two identical frames never contain each other.
  const parentOf = (element: CanvasAccessibleElement) => {
    let parent: CanvasAccessibleElement | null = null;
    for (const candidate of containers) {
      if (area(candidate.bounds) <= area(element.bounds)) continue;
      if (!candidate.contains?.(element.bounds)) continue;
      if (!parent || area(candidate.bounds) < area(parent.bounds)) parent = candidate;
    }
    return parent;
  };

  const nodes = new Map<string, CanvasAccessibleNode>();
  for (const element of elements) {
    nodes.set(element.id, { ...element, children: [] });
  }
  const roots: CanvasAccessibleNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node);
    const parentNode = parent && nodes.get(parent.id);
    (parentNode ? parentNode.children : roots).push(node);
  }

  const sort = (list: CanvasAccessibleNode[]) => {
    list.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
    for (const node of list) sort(node.children);
  };
  sort(roots);
  return roots;
}

/** Every node, depth first: the tree in reading order. */
export function flattenAccessibilityTree(
  roots: readonly CanvasAccessibleNode[],
): CanvasAccessibleNode[] {
  return roots.flatMap((node) => [node, ...flattenAccessibilityTree(node.children)]);
}

const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowDown: { x: 0, y: 1 },
  ArrowUp: { x: 0, y: -1 },
};

/**
 * Where a key moves focus. Arrows go to the nearest element whose centre lies
 * that way, with sideways distance counting double so aligned neighbours win;
 * Home and End jump to the ends of the reading order.
 */
export function navigateAccessibilityTree(
  roots: readonly CanvasAccessibleNode[],
  id: string,
  key: string,
): string | null {
  const nodes = flattenAccessibilityTree(roots);
  if (key === "Home") return nodes[0]?.id ?? null;
  if (key === "End") return nodes.at(-1)?.id ?? null;
  const direction = ARROWS[key];
  if (!direction) return null;

  const current = nodes.find((node) => node.id === id);
  if (!current) throw new Error(`Focused canvas element ${id} is not in the tree`);
  const centre = (rect: CanvasRect) => ({
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
  const from = centre(current.bounds);
  let best: { id: string; score: number } | null = null;
  for (const node of nodes) {
    const to = centre(node.bounds);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const along = dx * direction.x + dy * direction.y;
    if (node === current || along <= 0) continue;
    const across = Math.abs(dx * direction.y - dy * direction.x) * 2;
    const score = along * along + across * across;
    if (!best || score < best.score) best = { id: node.id, score };
  }
  return best?.id ?? null;
}
