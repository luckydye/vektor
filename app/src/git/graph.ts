/**
 * Laying a commit list out as a graph.
 *
 * Pure, and separate from the view, because this is the part with rules worth
 * testing: which column a commit sits in, which columns are still occupied
 * beside it, and which lines run between one row and the next.
 *
 * The input is `git log` order — newest first, parents after children — which
 * is what makes a single pass enough: by the time a commit is reached, every
 * child that expects it has already claimed a lane for it.
 */

/** The fields of a commit this layout needs; the rest is the view's business. */
export interface GraphCommit {
  oid: string;
  parents: string[];
}

export interface GraphEdge {
  /** Lane the line leaves from, at the top of the row. */
  from: number;
  /** Lane it arrives in, at the bottom. */
  to: number;
}

export interface GraphRow {
  /** Lane holding this commit's dot. */
  lane: number;
  /** Lanes drawn through this row, including this commit's own. */
  edges: GraphEdge[];
  /** How wide the graph is at this row, in lanes. */
  width: number;
}

/**
 * Assign every commit a lane and the lines that run past it.
 *
 * A lane is a slot that some already-seen commit is waiting on: when a commit
 * arrives, it takes the lane reserved for it, hands that lane to its first
 * parent, and gives any further parent a lane of its own — which is what makes
 * a merge fan out and a branch tip converge.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphRow[] {
  // Lane slots. A slot holds the oid it is waiting for, or null when free.
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  const claim = (oid: string): number => {
    const existing = lanes.indexOf(oid);
    if (existing !== -1) return existing;
    const free = lanes.indexOf(null);
    if (free !== -1) {
      lanes[free] = oid;
      return free;
    }
    lanes.push(oid);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    const lane = claim(commit.oid);
    // Every other lane waiting on this same commit converges here: a commit
    // with several children is one dot, not one per child.
    const merging: number[] = [];
    lanes.forEach((waiting, index) => {
      if (index !== lane && waiting === commit.oid) merging.push(index);
    });

    const before = lanes.map((waiting) => waiting !== null);
    for (const index of merging) lanes[index] = null;

    // The first parent continues this lane; the rest branch off into their own.
    const [first, ...rest] = commit.parents;
    lanes[lane] = first ?? null;
    const parentLanes: number[] = first === undefined ? [] : [lane];
    for (const parent of rest) parentLanes.push(claim(parent));

    const edges: GraphEdge[] = [];
    // Lines that merely pass by, untouched by this commit.
    before.forEach((occupied, index) => {
      if (!occupied || index === lane || merging.includes(index)) return;
      if (lanes[index] !== null) edges.push({ from: index, to: index });
    });
    // Lines arriving from lanes that converge on this commit.
    for (const index of merging) edges.push({ from: index, to: lane });
    // Lines leaving towards this commit's parents.
    for (const index of parentLanes) edges.push({ from: lane, to: index });

    // Trailing free lanes are not width; a graph that fanned out and closed
    // again should narrow back rather than keep the space forever.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      lane,
      edges,
      width: Math.max(lanes.length, lane + 1, ...edges.map((edge) => edge.to + 1)),
    });
  }

  return rows;
}
