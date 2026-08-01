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

/**
 * Animations on, unlike the rest of the suite.
 *
 * The config asks every context for reduced motion, which makes the canvas
 * deterministic — but `animateIn` returns immediately under that preference,
 * so the bug this covers cannot happen and the test would pass either way.
 *
 * It has to be `contextOptions`, not the `reducedMotion` fixture: the config
 * sets it there, that object goes straight to `newContext()`, and it wins.
 */
test.use({ contextOptions: { reducedMotion: "no-preference" } });

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";
const DOCUMENT = process.env.VEKTOR_E2E_DOCUMENT ?? "untitled";

function toastOpacity(page: Page) {
  return page.evaluate(() => {
    const toast = document.querySelector("#toast-container > div");
    return toast ? Number(getComputedStyle(toast).opacity) : -1;
  });
}

/**
 * One test, because publishing is the shortest path to a real toast and a
 * document can only be published once per seeded server.
 */
test("a toast fades in, stays readable, then leaves", async ({ page }) => {
  await page.goto(`/${SPACE}/doc/${DOCUMENT}`);

  // `#document-actions` is in the server-rendered markup, so waiting for it
  // proves nothing — the click would land on a button with no handler yet. The
  // toast container is rendered by the shell after it mounts, so it is the
  // hydration signal. Attached, not visible: it is empty and has no size.
  await page.waitForSelector("#toast-container", { state: "attached", timeout: 30_000 });
  // The editor has to exist too: publishing saves its content, and the button
  // is visible well before that is true.
  await page.waitForSelector(".ProseMirror", { timeout: 30_000 });
  const publish = page.locator('#document-actions button:has-text("Publish")').first();
  await expect(publish).toBeVisible();

  await publish.click();

  const toast = page.locator("#toast-container > div");
  await expect(toast).toBeVisible();
  await expect
    .poll(() => toastOpacity(page), {
      message: "the toast must become opaque, not merely exist",
      timeout: 5_000,
    })
    .toBeGreaterThan(0.9);

  // Still opaque once the enter animation has finished — a fill-less animation
  // that never started is exactly what left it on zero before.
  await page.waitForTimeout(600);
  expect(await toastOpacity(page)).toBeGreaterThan(0.9);

  // And it still expires on its own: 4s, plus the leave animation.
  await expect(toast).toHaveCount(0, { timeout: 15_000 });
});
