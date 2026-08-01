import { expect, test } from "@playwright/test";

/**
 * Opening a revision from its link, which only exists in a browser: the panel
 * reads the query on mount, the space and the document resolve asynchronously
 * after that, and the redline is rendered into a shadow root by a custom
 * element.
 *
 * Two bugs lived in that gap, both invisible to a happy-dom spec. The restore
 * effect gave up before the space arrived and never ran again, and the document
 * query — which hands back a fresh object on every refetch and cache push —
 * closed the revision view a beat after it opened. Either one leaves a shared
 * link rendering the plain published document, with no error anywhere.
 */

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";

test("a diff link renders the redline for both of its revisions", async ({
  page,
  request,
}) => {
  const spaces = await (await request.get("/api/v1/spaces")).json();
  const spaceId = spaces.find((s: { slug: string }) => s.slug === SPACE).id;

  const created = await (
    await request.post(`/api/v1/spaces/${spaceId}/documents`, {
      data: {
        content: "<p>Original</p>",
        type: "document",
        properties: { title: "Diff Link Fixture" },
      },
    })
  ).json();
  const { id: documentId, slug } = created.document;

  const first = await (
    await request.post(`/api/v1/spaces/${spaceId}/documents/${documentId}`, {
      data: { html: "<p>Original</p>" },
    })
  ).json();
  // Publishing pins the revision: the next save cannot overwrite it in place.
  await request.patch(`/api/v1/spaces/${spaceId}/documents/${documentId}`, {
    data: { publishedRev: first.revision.rev },
  });
  const second = await (
    await request.post(`/api/v1/spaces/${spaceId}/documents/${documentId}`, {
      data: { html: "<p>Revised</p>" },
    })
  ).json();

  const base = first.revision.rev;
  const rev = second.revision.rev;
  await page.goto(`/${SPACE}/doc/${slug}?revision=${rev}&base=${base}`);

  // Both sides named, so the banner cannot claim a comparison it did not make.
  await expect(
    page.getByText(`Comparing Revision ${rev} with Revision ${base}`),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("del.diff-del")).toHaveText("Original");
  await expect(page.locator("ins.diff-ins")).toHaveText("Revised");

  // Still standing once the document query has settled — it used to be torn
  // down by the refetch that follows the first paint.
  await page.waitForTimeout(3_000);
  await expect(page.locator("ins.diff-ins")).toBeVisible();
  expect(new URL(page.url()).search).toBe(`?revision=${rev}&base=${base}`);
});
