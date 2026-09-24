import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Switching between two extension routes.
 *
 * `ExtensionRouteView` resolves which extension owns the path. `Show` runs its
 * body once, when its condition first becomes truthy, and going from one
 * extension route to another leaves it truthy — so an extension id captured in
 * that body stayed pointed at whichever route was opened first while the route
 * path kept updating. Every view after the first failed with the mismatch:
 *
 *     Extension 'kanban' has no view registered for route 'tasmota-switches'
 *
 * The navigation has to be client-side. A full page load rebuilds the view and
 * would pass either way.
 */

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";
const BUNDLES = ["kanban", "tasmota-switches"] as const;

test.beforeAll(async ({ request }) => {
  const spaces = (await (await request.get("/api/v1/spaces")).json()) as Array<{
    id: string;
  }>;
  const spaceId = spaces[0]?.id;
  if (!spaceId) throw new Error("seed produced no space");

  for (const name of BUNDLES) {
    const response = await request.post(`/api/v1/spaces/${spaceId}/extensions`, {
      multipart: {
        file: {
          name: `${name}.zip`,
          mimeType: "application/zip",
          buffer: readFileSync(`../extensions/extensions/${name}/${name}.zip`),
        },
      },
    });
    expect(response.ok(), `installing ${name}`).toBe(true);
  }
});

test("renders each extension view when switching between them", async ({ page }) => {
  const mismatches: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/has no view registered for route|Failed to render view for route/.test(text)) {
      mismatches.push(text);
    }
  });

  await page.goto(`/${SPACE}`);
  await page.waitForSelector(`a[href="/${SPACE}/x/kanban"]`, { timeout: 30_000 });

  for (const name of BUNDLES) {
    // Client-side navigation, so the route view is reused rather than rebuilt.
    await page.click(`a[href="/${SPACE}/x/${name}"]`);
    await expect(page.locator("extension-view")).toBeVisible();
    await expect(
      page.locator(".extension-error, [class*=extension-error]"),
      `${name} must render rather than report an error`,
    ).toHaveCount(0);
  }

  expect(mismatches, "no view was asked of the wrong extension").toEqual([]);
});

test("goes back to the first extension without breaking it", async ({ page }) => {
  const mismatches: string[] = [];
  page.on("console", (message) => {
    if (/has no view registered for route/.test(message.text())) {
      mismatches.push(message.text());
    }
  });

  await page.goto(`/${SPACE}`);
  await page.waitForSelector(`a[href="/${SPACE}/x/kanban"]`, { timeout: 30_000 });

  await page.click(`a[href="/${SPACE}/x/kanban"]`);
  await expect(page.locator("extension-view")).toBeVisible();
  await page.click(`a[href="/${SPACE}/x/tasmota-switches"]`);
  await expect(page.locator("extension-view")).toBeVisible();
  await page.click(`a[href="/${SPACE}/x/kanban"]`);
  await expect(page.locator("extension-view")).toBeVisible();

  expect(mismatches).toEqual([]);
});
