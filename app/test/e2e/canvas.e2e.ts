import { expect, type Page, test } from "@playwright/test";

/**
 * The canvas, in a real browser.
 *
 * None of this is reachable from the happy-dom suites: `<vektor-canvas>`
 * upgrades from a module side effect, lays itself out from measured geometry,
 * and is driven entirely by pointer events.
 *
 * The failure that motivated the suite is silent. A type-only import of the
 * module that calls `customElements.define` is erased at build time, the
 * element never upgrades, the page renders an empty box — and every other
 * suite passes.
 *
 * Most assertions here are that the DOM *changed* after an interaction, not
 * that the first paint is right. A canvas that stops redrawing looks correct
 * until you touch it, and that is the bug class worth paying for a browser.
 */

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";
const CANVAS = process.env.VEKTOR_E2E_CANVAS ?? "untitled-2";

const NOTE = '[data-shape-id="shape-fixture-note"]';

async function openCanvas(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`/${SPACE}/doc/${CANVAS}`);
  await page.waitForSelector("vektor-canvas .canvas-viewport", { timeout: 30_000 });
  // Shapes paint from measured geometry, a frame after the element mounts.
  await page.waitForSelector("vektor-canvas .canvas-shape", { timeout: 30_000 });
  return errors;
}

/**
 * A point on the shape that is not its inline editor.
 *
 * A note fills itself with a `rich-text-editor`, so pressing the middle of one
 * starts editing text rather than dragging — the grab area is the border.
 */
async function grabPoint(page: Page) {
  const box = await page.locator(NOTE).boundingBox();
  if (!box) throw new Error("note shape has no box");
  return { x: box.x + box.width / 2, y: box.y + 4 };
}

async function noteLeft(page: Page) {
  const box = await page.locator(NOTE).boundingBox();
  if (!box) throw new Error("note shape has no box");
  return Math.round(box.x);
}

test("upgrades the host element and paints the document", async ({ page }) => {
  const errors = await openCanvas(page);

  expect(
    await page.evaluate(() => !!customElements.get("vektor-canvas")),
    "the host element must register, or the canvas is an empty box",
  ).toBe(true);

  // The seed also carries a section shape, which does not render — see the
  // canvas notes. Asserting the count that holds today means this fails if
  // *these* stop rendering, rather than encoding the section as expected.
  await expect(page.locator("vektor-canvas .canvas-shape")).toHaveCount(2);
  await expect(page.locator(NOTE)).toBeVisible();
  expect(errors).toEqual([]);
});

test("selects a shape on click", async ({ page }) => {
  await openCanvas(page);
  const grab = await grabPoint(page);

  await page.mouse.click(grab.x, grab.y);
  await expect(page.locator("vektor-canvas .canvas-selection")).toHaveCount(1);
});

test("repaints while a shape is dragged", async ({ page }) => {
  await openCanvas(page);
  const before = await noteLeft(page);
  const grab = await grabPoint(page);

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(grab.x + step * 14, grab.y + step * 6);
  }

  // Mid-drag, before the pointer is released: a canvas that only repaints on
  // commit would still be showing the old position here.
  await expect
    .poll(() => noteLeft(page), { message: "the shape must follow the pointer" })
    .toBeGreaterThan(before + 60);

  await page.mouse.up();
  await expect.poll(() => noteLeft(page)).toBeGreaterThan(before + 60);
});

test("undo repaints the shape back", async ({ page }) => {
  await openCanvas(page);
  const before = await noteLeft(page);
  const grab = await grabPoint(page);

  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(grab.x + step * 14, grab.y + step * 6);
  }
  await page.mouse.up();
  await expect.poll(() => noteLeft(page)).toBeGreaterThan(before + 60);

  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() => noteLeft(page), { message: "undo has to repaint, not just revert state" })
    .toBeLessThan(before + 20);
});

test("switches the active tool from the keyboard", async ({ page }) => {
  await openCanvas(page);
  const pressed = page.locator("vektor-canvas [aria-pressed=true]");
  const before = await pressed.count();

  await page.keyboard.press("d");

  await expect
    .poll(() => pressed.count(), { message: "the toolbar must reflect the new tool" })
    .not.toBe(before);
});

test("opens the canvas context menu on right click", async ({ page }) => {
  await openCanvas(page);
  const grab = await grabPoint(page);

  await page.mouse.click(grab.x, grab.y, { button: "right" });

  await expect(page.locator(".canvas-context-menu")).toBeVisible();
});
