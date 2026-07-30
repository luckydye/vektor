/**
 * Fixed seed data for the screenshot suite.
 *
 * Every value here is deterministic. The server is started `--in-memory`, so it
 * begins empty on each run and this is the only content that exists — no
 * ordering surprises from a leftover database, and the same pixels on any
 * machine.
 *
 * Dates follow `noAuth.ts`'s `LOCAL_USER`, which uses `new Date(0)`. Anything
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
} as const;

export interface SeededSpace {
  spaceId: string;
  slug: string;
  documentSlugs: string[];
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

  return { spaceId: space.id, slug: space.slug, documentSlugs };
}
