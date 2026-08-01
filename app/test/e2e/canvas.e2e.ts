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
 * Most assertions are that something *changed* after an interaction rather
 * than that the first paint is right. A canvas that stops redrawing looks
 * correct until you touch it, and that is the bug class worth a browser.
 *
 * Read the notes on `paintedPixels` before adding a test. The canvas draws
 * across three layers and a DOM tree, and counting the wrong one is the
 * easiest way to write an assertion that cannot fail.
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
 * How much of a canvas layer is painted.
 *
 * The layers are the only honest signal for anything drawn in 2D, and there is
 * a trap in the alternative: `.canvas-selection` is the *overlay element*, one
 * per canvas, present whether or not anything is selected. Asserting it exists
 * passes always. Its pixels are what tell you there is a selection.
 *
 *   canvas-scene       shapes whose extension paints (sections, strokes)
 *   canvas-active-ink  the stroke currently being drawn
 *   canvas-selection   selection outlines and transform handles
 */
function paintedPixels(page: Page, layer: string) {
  return page.evaluate((className) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`canvas.${className}`);
    if (!canvas) throw new Error(`no ${className} layer`);
    const { data } = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height);
    let painted = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) painted++;
    return painted;
  }, layer);
}

/**
 * A point on the note that is not its inline editor.
 *
 * A note fills itself with a `rich-text-editor`, so pressing the middle starts
 * editing text rather than dragging — the grab area is the border.
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

async function viewport(page: Page) {
  const box = await page.locator("vektor-canvas .canvas-viewport").boundingBox();
  if (!box) throw new Error("no viewport");
  return box;
}

test("upgrades the host element and paints the document", async ({ page }) => {
  const errors = await openCanvas(page);

  expect(
    await page.evaluate(() => !!customElements.get("vektor-canvas")),
    "the host element must register, or the canvas is an empty box",
  ).toBe(true);

  // Two of the fixture's three shapes are DOM elements. The third is a
  // section, whose extension declares `surface: "canvas"` — it is painted on
  // the scene layer and deliberately has no DOM node, so counting DOM shapes
  // and finding two is correct rather than a missing shape.
  await expect(page.locator("vektor-canvas .canvas-shape")).toHaveCount(2);
  await expect(page.locator(NOTE)).toBeVisible();
  expect(await paintedPixels(page, "canvas-scene")).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("selects on click and clears on a click into empty space", async ({ page }) => {
  await openCanvas(page);
  const grab = await grabPoint(page);
  const box = await viewport(page);

  expect(await paintedPixels(page, "canvas-selection")).toBe(0);

  await page.mouse.click(grab.x, grab.y);
  await expect
    .poll(() => paintedPixels(page, "canvas-selection"), {
      message: "selecting must draw handles on the selection layer",
    })
    .toBeGreaterThan(0);

  await page.mouse.click(box.x + box.width - 40, box.y + 40);
  await expect
    .poll(() => paintedPixels(page, "canvas-selection"), {
      message: "clicking empty canvas must clear the selection",
    })
    .toBe(0);
});

test("draws the marquee while dragging across empty space", async ({ page }) => {
  await openCanvas(page);
  const box = await viewport(page);
  const startX = box.x + box.width - 260;
  const startY = box.y + 40;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(startX - step * 12, startY + step * 26);
  }

  await expect(page.locator(".canvas-marquee")).toBeVisible();

  await page.mouse.up();
  await expect(page.locator(".canvas-marquee")).toHaveCount(0);
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

/**
 * The toolbar is a Solid component rendered beside the element, not inside it,
 * so it is asserted by name. Counting `[aria-pressed]` anywhere under
 * `vektor-canvas` used to pass on the tool-properties bar instead.
 */
function activeToolLabel(page: Page) {
  return page
    .locator('.canvas-toolbar [aria-pressed="true"]')
    .first()
    .getAttribute("aria-label");
}

test("reflects the active tool in the toolbar, by key and by click", async ({ page }) => {
  await openCanvas(page);
  expect(await activeToolLabel(page)).toBe("Select");

  await page.keyboard.press("n");
  await expect
    .poll(() => activeToolLabel(page), { message: "a shortcut must update the toolbar" })
    .toBe("Note");

  // Chrome sits outside the element, so its clicks never reach the host's own
  // input listener — the command has to ask for the frame itself.
  await page.locator('.canvas-toolbar button[aria-label="Select"]').first().click();
  await expect
    .poll(() => activeToolLabel(page), { message: "a toolbar click must take effect" })
    .toBe("Select");
});

test("undo and redo buttons follow the document", async ({ page }) => {
  await openCanvas(page);
  const undo = page.locator('.canvas-toolbar button[aria-label="Undo"]');
  await expect(undo).toBeDisabled();

  const grab = await grabPoint(page);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await page.mouse.move(grab.x + step * 14, grab.y + step * 6);
  }
  await page.mouse.up();

  await expect(undo, "a completed drag must enable undo").toBeEnabled();
  await undo.click();
  await expect.poll(() => noteLeft(page)).toBeLessThan(grab.x);
});

test("shows tool properties only while a tool has them", async ({ page }) => {
  await openCanvas(page);
  const bar = page.locator(".canvas-tool-properties");
  await expect(bar, "the select tool configures nothing").toHaveCount(0);

  await page.keyboard.press("d");
  await expect(bar).toBeVisible();
  await expect(page.locator(".canvas-draw-mode")).not.toHaveCount(0);

  const swatches = page.locator(".canvas-tool-properties .canvas-color-swatch");
  await swatches.nth(2).click();
  await expect(
    page.locator(".canvas-tool-properties .canvas-color-swatch.active"),
    "picking a colour must mark it active",
  ).toHaveCount(1);

  await page.keyboard.press("v");
  await expect(bar).toHaveCount(0);
});

test("shows the appearance panel only while something is selected", async ({ page }) => {
  await openCanvas(page);
  const sidebar = page.locator(".canvas-properties-sidebar");
  await expect(sidebar).toHaveCount(0);

  const grab = await grabPoint(page);
  await page.mouse.click(grab.x, grab.y);

  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(".canvas-color-swatch")).not.toHaveCount(0);

  const box = await viewport(page);
  await page.mouse.click(box.x + box.width - 40, box.y + 40);
  await expect(sidebar, "clearing the selection must hide it").toHaveCount(0);
});

test("inserts a shape by dragging with a tool, and undoes it", async ({ page }) => {
  await openCanvas(page);
  const shapes = page.locator("vektor-canvas .canvas-shape");
  const before = await shapes.count();
  const box = await viewport(page);

  // A tool needs a drag, not a click: the drag is what gives the new shape its
  // size. A click with the note tool selected inserts nothing.
  await page.keyboard.press("n");
  const startX = box.x + 300;
  const startY = box.y + box.height - 150;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(startX + step * 18, startY + step * 8);
  }
  await page.mouse.up();

  await expect
    .poll(() => shapes.count(), { message: "the new shape must appear" })
    .toBe(before + 1);

  // Put the document back: every test in this file shares one seeded server.
  // The click is what makes the undo land — a new note opens for editing and
  // keeps focus, so the keystroke would otherwise go to its text editor.
  await page.mouse.click(box.x + 40, box.y + 40);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => shapes.count()).toBe(before);
});
