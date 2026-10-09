import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

/**
 * The canvas platform extensions build on: an extension inspector and image
 * processor (the seeded `canvas-invert` fixture), a clipping section, and
 * exporting that section from its title chrome.
 *
 * The seed puts a solid red image half-way out of a clipping section, so one
 * pixel read tells red (raw), cyan (inverted) and nothing (clipped) apart.
 */

const SPACE = process.env.VEKTOR_E2E_SPACE ?? "visual";
const CANVAS = process.env.VEKTOR_E2E_CANVAS_PLATFORM ?? "platform-canvas-fixture";
const IMAGE = '[data-shape-id="shape-fixture-image"]';
const SECTION = '[data-shape-id="shape-fixture-clip-section"]';

async function openCanvas(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem("onboarding-document-organization", "true"),
  );
  await page.goto(`/${SPACE}/doc/${CANVAS}`);
  await page.waitForSelector("vektor-canvas .canvas-viewport", { timeout: 30_000 });
  await page.waitForSelector(IMAGE, { state: "attached", timeout: 30_000 });
}

async function box(page: Page, selector: string) {
  const found = await page.locator(selector).boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
}

/** The scene layer's RGBA at a page point; see `paintedPixels` in canvas.e2e.ts. */
function scenePixel(page: Page, point: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.canvas-scene");
    if (!canvas) throw new Error("no scene layer");
    const rect = canvas.getBoundingClientRect();
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d")!;
    context.drawImage(canvas, 0, 0);
    const scale = canvas.width / rect.width;
    const px = Math.round((x - rect.left) * scale);
    const py = Math.round((y - rect.top) * scale);
    return Array.from(context.getImageData(px, py, 1, 1).data);
  }, point);
}

const isRed = ([r, g, b, a]: number[]) => a > 200 && r > 180 && g < 90 && b < 90;
const isCyan = ([r, g, b, a]: number[]) => a > 200 && r < 90 && g > 180 && b > 180;

async function imageCentre(page: Page) {
  const image = await box(page, IMAGE);
  return { x: image.x + image.width / 2, y: image.y + image.height / 2 };
}

test("an extension inspector edits the image through its processor", async ({ page }) => {
  await openCanvas(page);
  const centre = await imageCentre(page);
  await expect.poll(async () => isRed(await scenePixel(page, centre))).toBe(true);

  await page.mouse.click(centre.x, centre.y);
  const invert = page.getByLabel("Invert colours");
  await expect(invert).toBeVisible();
  await invert.check();
  await expect
    .poll(async () => isCyan(await scenePixel(page, centre)), {
      message: "the processor's output has to replace the image",
    })
    .toBe(true);

  await page.locator('.canvas-toolbar button[aria-label="Undo"]').click();
  await expect
    .poll(async () => isRed(await scenePixel(page, centre)), {
      message: "undo removes the slot, so the raw image paints again",
    })
    .toBe(true);
  await expect(invert).not.toBeChecked();
});

test("a clipping section cuts its contents and their hit area", async ({ page }) => {
  await openCanvas(page);
  const section = await box(page, SECTION);
  const image = await box(page, IMAGE);
  const overhang = {
    x: (section.x + section.width + image.x + image.width) / 2,
    y: image.y + image.height / 2,
  };
  const inside = { x: (image.x + section.x + section.width) / 2, y: overhang.y };

  await expect.poll(async () => isRed(await scenePixel(page, inside))).toBe(true);
  expect(isRed(await scenePixel(page, overhang)), "the overhang must not paint").toBe(
    false,
  );

  await page.mouse.click(overhang.x, overhang.y);
  await expect(page.getByLabel("Invert colours")).toHaveCount(0);
  await page.mouse.click(inside.x, inside.y);
  await expect(page.getByLabel("Invert colours")).toBeVisible();
});

test("a section exports its contents at the chosen scale", async ({ page }) => {
  await openCanvas(page);
  const section = await box(page, SECTION);
  // The chips sit right-aligned on the title row, 26px above the frame: Export
  // flush with the right edge, the scale chip just left of it.
  const row = section.y - 26 + 11;
  const right = section.x + section.width;

  await page.mouse.click(right - 75, row);
  await page.getByRole("menuitem", { name: "2×" }).click();

  const download = page.waitForEvent("download");
  await page.mouse.click(right - 8, row);
  await page.getByRole("menuitem", { name: "PNG" }).click();
  const file = await (await download).path();
  const png = readFileSync(file);
  expect(png.readUInt32BE(16), "width").toBe(800);
  expect(png.readUInt32BE(20), "height").toBe(600);

  // Image centre in section units (300, 150), doubled.
  const pixel = await page.evaluate(async (base64) => {
    const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    return Array.from(context.getImageData(600, 300, 1, 1).data);
  }, png.toString("base64"));
  expect(isRed(pixel), `exported pixel ${pixel}`).toBe(true);
});

test("the section tool sizes a new frame by dragging", async ({ page }) => {
  await openCanvas(page);
  const mirrors = page.locator("vektor-canvas .canvas-text-mirror > li");
  const before = await mirrors.count();
  const viewport = await box(page, "vektor-canvas .canvas-viewport");
  const start = { x: viewport.x + 60, y: viewport.y + viewport.height - 260 };

  await page.keyboard.press("s");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(start.x + step * 24, start.y + step * 16);
  }
  await page.mouse.up();

  await expect.poll(() => mirrors.count()).toBe(before + 1);
  const sizes = await mirrors.evaluateAll((items) =>
    items.map((item) => {
      const rect = item.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  const created = sizes.find(
    (rect) => Math.abs(rect.x - start.x) < 2 && Math.abs(rect.y - start.y) < 2,
  );
  expect(created, "a frame from the drag start").toBeDefined();
  expect(created?.width).toBeCloseTo(240, -1);
  expect(created?.height).toBeCloseTo(160, -1);

  // The new frame opens its title for editing; leave it before undoing.
  await page.keyboard.press("Escape");
  await page.locator('.canvas-toolbar button[aria-label="Undo"]').click();
  await expect.poll(() => mirrors.count()).toBe(before);
});
