import { expect as base, test as playwright } from "@playwright/test";

/**
 * Determinism controls for the screenshot suite (plan section 4.4).
 *
 * A flaky visual suite gets ignored, and then the cutover has no check at all —
 * so each of these exists to remove one source of per-run variation.
 */

/** Midnight UTC on a fixed date. Everything relative is measured from here. */
export const FIXED_TIME = new Date("2026-06-15T12:00:00.000Z");

/**
 * Kills every transition and animation.
 *
 * Also means View Transitions never run: `withViewTransition` checks reduced
 * motion itself, so these captures always take the unanimated branch and a
 * screenshot cannot catch a mid-morph frame (plan section 5.4).
 */
const NO_MOTION = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
  /* The caret blinks; a focused input would otherwise differ between runs. */
`;

/**
 * Regions that cannot be made deterministic and are masked instead.
 *
 * Presence colours are randomised per session (`useCanvasCursorColor`) and
 * avatars are generated from a seed, so both differ run to run without
 * indicating anything.
 */
export const MASKS = [
  "vektor-avatar",
  "[data-presence-cursor]",
  ".canvas-presence-cursor",
];

export const test = playwright.extend({
  page: async ({ page }, use) => {
    // Freeze before the first navigation: `formatRelativeTime` reads the clock
    // during render, and an unfrozen one makes every snapshot fail tomorrow.
    await page.clock.setFixedTime(FIXED_TIME);
    await page.addStyleTag({ content: NO_MOTION }).catch(() => {
      // No document yet on the very first call; the init script below covers it.
    });
    await page.addInitScript((css) => {
      window.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.append(style);
      });
    }, NO_MOTION);
    await use(page);
  },
});

export const expect = base;

/**
 * Waits for the app to be ready rather than for a timeout.
 *
 * Not `networkidle`: the app opens a realtime socket on mount, so the network
 * never goes idle and the wait hangs until the test times out.
 *
 * Astro marks a server-rendered island with an `ssr` attribute and removes it
 * once the island has hydrated, which is the actual "interactive" signal. A
 * shot taken before that catches server markup with no interactivity applied —
 * still deterministic, but a screenshot of the wrong thing.
 */
export async function waitForApp(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");

  if ((await page.locator("astro-island").count()) > 0) {
    await page.waitForFunction(() => {
      const islands = [...document.querySelectorAll("astro-island")];
      return islands.length > 0 && islands.every((el) => !el.hasAttribute("ssr"));
    });
  }

  // `document.fonts.ready` resolves with a FontFaceSet, which cannot cross the
  // bridge — resolve to undefined instead of hanging on serialization.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/**
 * Waits for the canvas to have drawn, not merely mounted.
 *
 * `waitForApp` returns when the island is interactive, which for the canvas is
 * several frames before there is anything to photograph: the host measures its
 * viewport, syncs shapes out of Yjs, and only then paints. Waiting for the
 * seeded shapes plus a settled frame is the difference between a baseline of
 * the canvas and a baseline of an empty grid.
 */
export async function waitForCanvas(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.waitForSelector("vektor-canvas .canvas-viewport", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("vektor-canvas .canvas-shape").length > 0,
    undefined,
    { timeout: 30_000 },
  );
  // Text-bearing shapes embed a <rich-text-editor>, which shows its raw value
  // until Tiptap has mounted inside its shadow root. Shooting before that
  // captures escaped HTML where the prose should be.
  // Checked per text-bearing shape rather than over "every editor on the page":
  // the editors are created asynchronously, so an `every` on an empty list is
  // trivially true and the wait returns before any of them exist.
  await page.waitForFunction(
    () => {
      const textual = [
        ...document.querySelectorAll(
          "vektor-canvas .canvas-shape.note, vektor-canvas .canvas-shape.text",
        ),
      ];
      return (
        textual.length > 0 &&
        textual.every((shape) => {
          // The rendered prose, not the element: `.tiptap` appears before its
          // content does, and a shot in that window catches an empty note.
          const prose = shape
            .querySelector("rich-text-editor")
            ?.shadowRoot?.querySelector(".tiptap");
          return (prose?.textContent?.trim() ?? "").length > 0;
        })
      );
    },
    undefined,
    { timeout: 30_000 },
  );

  // Two rAFs: one for the render the shapes triggered, one for the ink and
  // selection layers that are scheduled from it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
