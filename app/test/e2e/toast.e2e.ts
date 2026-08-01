import { expect, type Page, test } from "@playwright/test";

/**
 * Toasts, which are only really observable in a browser.
 *
 * The enter animation used to be started from the `ref` callback, which Solid
 * runs before the node is in the document. An animation on a detached element
 * never gets a start time, so it held the toast at its first keyframe —
 * `opacity: 0` — for its whole life. Nothing threw, the element was present and
 * correctly sized, and the only visible symptom was a flicker on the way out,
 * when the leave animation ran on a node that was by then attached.
 *
 * So the assertion is on computed opacity. Presence proves nothing here.
 */

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";
const DOCUMENT = process.env.VEKTOR_E2E_DOCUMENT ?? "untitled";

function toastOpacity(page: Page) {
  return page.evaluate(() => {
    const toast = document.querySelector("#toast-container > div");
    return toast ? Number(getComputedStyle(toast).opacity) : -1;
  });
}

test("a toast fades in and stays readable", async ({ page }) => {
  await page.goto(`/${SPACE}/doc/${DOCUMENT}`);
  await page.waitForSelector("#document-actions", { timeout: 30_000 });

  // Publishing is the shortest path to a real toast.
  await page.locator('#document-actions button:has-text("Publish")').first().click();

  await expect(page.locator("#toast-container > div")).toBeVisible();
  await expect
    .poll(() => toastOpacity(page), {
      message: "the toast must actually become opaque, not just exist",
      timeout: 5_000,
    })
    .toBeGreaterThan(0.9);

  // Still there a moment later: the enter animation must not leave it hidden
  // once it finishes, which is what a fill-less animation on a detached
  // element did.
  await page.waitForTimeout(500);
  expect(await toastOpacity(page)).toBeGreaterThan(0.9);
});

test("a toast leaves on its own", async ({ page }) => {
  await page.goto(`/${SPACE}/doc/${DOCUMENT}`);
  await page.waitForSelector("#document-actions", { timeout: 30_000 });
  await page.locator('#document-actions button:has-text("Publish")').first().click();
  await expect(page.locator("#toast-container > div")).toBeVisible();

  await expect(page.locator("#toast-container > div"), {
    // The default duration is 4s plus the leave animation.
  }).toHaveCount(0, { timeout: 15_000 });
});
