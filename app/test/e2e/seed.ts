/**
 * Fixed seed data for the screenshot suite.
 *
 * Every value here is deterministic. The server is started `--in-memory`, so it
 * begins empty on each run and this is the only content that exists — no
 * ordering surprises from a leftover database, and the same pixels on any
 * machine.
 *
 * Dates follow `config.ts`'s `LOCAL_USER`, which uses `new Date(0)`. Anything
 * the API stamps itself (audit log timestamps, `updatedAt`) is *not* fixed, so
 * the clock is frozen browser-side instead — see `fixture.ts`.
 */

export const SEED = {
  space: { name: "Visual Fixture", slug: "visual" },
  documents: [
    { title: "Getting started", content: "# Getting started\n\nA seeded document." },
    { title: "Second page", content: "# Second page\n\nMore seeded content." },
  ],
  category: { name: "Guidelines", slug: "guidelines", color: "#4ECDC4" },
  /**
   * A canvas with fixed geometry.
   *
   * Ids and timestamps are literals rather than generated, because the canvas
   * sorts shapes by `updatedAt` and paints selection chrome per id — either one
   * varying would move pixels between runs for no reason.
   */
  canvas: {
    title: "Canvas fixture",
    shapes: [
      {
        id: "shape-fixture-note",
        type: "note",
        frame: { x: -220, y: -140, width: 220, height: 140, rotation: 0 },
        style: { color: "#fde68a" },
        data: { text: "A seeded note." },
        updatedAt: 1_000,
      },
      {
        id: "shape-fixture-text",
        type: "text",
        frame: { x: 80, y: -120, width: 240, height: 60, rotation: 0 },
        style: { color: "transparent" },
        data: { text: "Seeded text" },
        updatedAt: 2_000,
      },
      {
        id: "shape-fixture-section",
        type: "section",
        frame: { x: -260, y: 60, width: 560, height: 220, rotation: 0 },
        style: { color: "#bfdbfe" },
        data: { title: "Seeded section" },
        updatedAt: 3_000,
      },
    ],
    strokes: [
      {
        id: "stroke-fixture",
        kind: "freehand",
        rotation: 0,
        style: { color: "#111827", width: 3 },
        points: [
          { x: 340, y: 120, pressure: 0.5 },
          { x: 400, y: 160, pressure: 0.5 },
          { x: 460, y: 110, pressure: 0.5 },
        ],
        updatedAt: 4_000,
      },
    ],
  },
  /**
   * A second canvas, so navigating between two of them is testable. Shares no
   * shape id with the first, and is filed under the category so the sidebar
   * tree has a link to click.
   */
  secondCanvas: {
    title: "Other canvas fixture",
    shapes: [
      {
        id: "shape-fixture-other-note",
        type: "note",
        frame: { x: -120, y: -80, width: 220, height: 140, rotation: 0 },
        style: { color: "#bbf7d0" },
        data: { text: "The other canvas." },
        updatedAt: 1_000,
      },
    ],
  },
} as const;

export interface SeededSpace {
  spaceId: string;
  slug: string;
  documentSlugs: string[];
  canvasSlug: string;
  secondCanvasSlug: string;
}

export async function seed(baseUrl: string): Promise<SeededSpace> {
  const api = `${baseUrl}/api/v1`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} -> ${response.status}`);
    return response.json();
  };

  const { space } = await post("/spaces", SEED.space);
  await post(`/spaces/${space.id}/categories`, SEED.category).catch(() => {
    // Categories are optional for the shots that do not show the sidebar.
  });

  const documentSlugs: string[] = [];
  for (const doc of SEED.documents) {
    const { document } = await post(`/spaces/${space.id}/documents`, {
      ...doc,
      type: "document",
    });
    documentSlugs.push(document.slug);
  }

  const { document: canvas } = await post(`/spaces/${space.id}/documents`, {
    title: SEED.canvas.title,
    type: "canvas",
    content: JSON.stringify({
      version: 1,
      shapes: SEED.canvas.shapes,
      strokes: SEED.canvas.strokes,
    }),
  });

  const { document: secondCanvas } = await post(`/spaces/${space.id}/documents`, {
    properties: {
      title: SEED.secondCanvas.title,
      category: SEED.category.slug,
    },
    type: "canvas",
    content: JSON.stringify({
      version: 1,
      shapes: SEED.secondCanvas.shapes,
      strokes: [],
    }),
  });

  return {
    spaceId: space.id,
    slug: space.slug,
    documentSlugs,
    canvasSlug: canvas.slug,
    secondCanvasSlug: secondCanvas.slug,
  };
}
