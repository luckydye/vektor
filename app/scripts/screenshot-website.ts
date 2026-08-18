/**
 * Re-shoots the marketing website's product screenshots against the real app.
 *
 * The website ships eight product shots — four views, light and dark — that are
 * the first thing a visitor sees. Hand-captured they drift: a redesign lands,
 * the shots keep showing last quarter's chrome, and nobody notices until the
 * shots and the product disagree. Capturing them from a seeded, in-memory server makes a
 * refresh one command, and makes every shot reproducible on any machine.
 *
 * Reuses the e2e rig, so nothing here touches a developer's own database.
 *
 *   bun ./scripts/screenshot-website.ts                  # build, boot, seed, shoot
 *   VEKTOR_SKIP_BUILD=1 bun ./scripts/screenshot-website.ts
 *   VEKTOR_SHOT_SCALE=2 bun ./scripts/screenshot-website.ts   # retina (4x the bytes)
 *   VEKTOR_SHOT_QUALITY=100 bun ./scripts/screenshot-website.ts
 *   VEKTOR_WEBSITE_IMAGES=/path/to/images bun ./scripts/screenshot-website.ts
 */
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { transform } from "#files/native/addon.ts";
import { startTestServer, testBaseUrl, waitForServer } from "#test/helpers/server.ts";
import { ORGANIZATION_TOUR_KEY } from "#utils/onboarding.ts";
import { THEME_STORAGE_KEY } from "#utils/themePreference.ts";

const PORT = Number(process.env.VEKTOR_SHOT_PORT ?? 4397);
const APP_DIR = new URL("..", import.meta.url).pathname;

/**
 * Where the website keeps its product shots.
 *
 * Defaults to the sibling checkout, which is how the two repos sit locally. It
 * is an explicit failure rather than a silent `mkdir` when missing: writing
 * eight images into a directory the website does not read is worse than stopping.
 */
const OUT_DIR =
  process.env.VEKTOR_WEBSITE_IMAGES ?? `${APP_DIR}../../vektor-cloud/src/assets/images`;

/**
 * The website uses these as plain `<img>` with no Astro image pipeline behind
 * them, so the encoded bytes are the shipped bytes. 1x keeps the geometry the
 * page already lays out against; `VEKTOR_SHOT_SCALE=2` doubles the resolution
 * without changing the aspect ratio.
 */
const VIEWPORT = { width: 1440, height: 1000 };
const SCALE = Number(process.env.VEKTOR_SHOT_SCALE ?? 1);

/**
 * Shipped as WebP, re-encoded from the PNG the browser hands back.
 *
 * The hero loads its light *and* dark image eagerly, so these land on the
 * critical path in pairs — as PNG the eight come to about 2.8 MB, and at this
 * quality to roughly a fifth of that with no difference visible at 1x. Encoded
 * through the app's own image addon rather than a new dependency.
 */
const QUALITY = Number(process.env.VEKTOR_SHOT_QUALITY ?? 92);

type Theme = "light" | "dark";
const THEMES: Theme[] = ["light", "dark"];

interface Shot {
  /** Output basename; the theme suffix is appended. */
  name: string;
  /** Built from the seeded slugs, since every run gets fresh ones. */
  path: (seeded: Seeded) => string;
  /**
   * A selector that only matches once the view has its real content. Every shot
   * needs one: the shell paints immediately and the body arrives per query, so
   * a fixed sleep would sometimes capture skeletons.
   */
  ready: string;
  /** Extra settling for views that keep painting after their content lands. */
  settleMs?: number;
  /** Framing the view needs before it is worth photographing. */
  prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  {
    name: "vektor-editor",
    path: (seeded) => `/${seeded.space}/doc/${seeded.narrative}`,
    ready: "h2:has-text('Launch checklist')",
  },
  {
    name: "vektor-canvas",
    path: (seeded) => `/${seeded.space}/doc/${seeded.canvas}`,
    // The canvas is a custom element that measures geometry and then auto-fits
    // the camera to the content, so it lands a frame or two after the notes do.
    ready: "canvas-note",
    settleMs: 1600,
    // The camera the canvas sets for itself on load is capped at zoom 1
    // (`fitView(1)`), which parks a board this size in the middle of a lot of
    // empty grid. The toolbar's own control re-frames it with the cap lifted —
    // the same thing a reader would press, so the shot shows a real framing
    // rather than a camera the script reached in and set.
    prepare: async (page) => {
      await page.getByRole("button", { name: "Fit to view" }).click();
      // The click leaves the control focused and the pointer on it; both paint.
      await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
      await page.mouse.move(VIEWPORT.width / 2, 120);
    },
  },
  {
    name: "vektor-database",
    path: (seeded) => `/${seeded.space}/doc/${seeded.roadmap}`,
    ready: "text=Onboarding templates",
  },
  {
    name: "vektor-workspace",
    path: (seeded) => `/${seeded.space}/`,
    ready: "text=Space Activity",
    settleMs: 900,
  },
];

/**
 * The fixture the shots are taken of.
 *
 * A studio planning a product launch: enough of a document tree that the sidebar
 * reads as a real workspace, and one document per format the website advertises.
 * Everything here is literal — the same content on every machine, so a re-shoot
 * differs only where the product changed.
 */
const SPACE = { name: "Northstar Studio", slug: "northstar-studio" };

const CATEGORIES = [
  { name: "Strategy", slug: "strategy", color: "#7c3aed" },
  { name: "Product", slug: "product", color: "#2563eb" },
  { name: "Design", slug: "design", color: "#ec4899" },
  { name: "Research", slug: "research", color: "#14b8a6" },
  { name: "Operations", slug: "operations", color: "#f59e0b" },
];

/** The document that the hero shot is taken of. */
const NARRATIVE_HTML = `
<h1>Spring launch narrative</h1>
<p>The spring release gives creative teams a calmer place to turn scattered thinking into durable, connected knowledge.</p>
<h2>The promise</h2>
<blockquote><p><em>One collaborative workspace for the notes, decisions, data, and visual thinking that move a team forward.</em></p></blockquote>
<h2>Audience</h2>
<ul>
<li><strong>Creative leads</strong> aligning a cross-functional launch.</li>
<li><strong>Product teams</strong> connecting discovery to delivery.</li>
<li><strong>Studios</strong> that want an open, adaptable home for client knowledge.</li>
</ul>
<h2>Story arc</h2>
<ol>
<li>Show the cost of fragmented creative work.</li>
<li>Reveal a workspace where every format stays connected.</li>
<li>Prove ownership through self-hosting, APIs, and extensions.</li>
</ol>
<h2>Launch checklist</h2>
<ul>
<li>Align the story across product, design, and community.</li>
<li>Invite early teams into the hosted beta.</li>
<li>Publish extension guides for makers.</li>
</ul>
`.trim();

/**
 * Supporting pages, filed so the sidebar has depth.
 *
 * `parent` names another entry's title; the tree sorts alphabetically, so the
 * order here only decides what exists, never what the shot shows.
 */
const PAGES: { title: string; category: string; parent?: string; body: string }[] = [
  { title: "Brand voice", category: "strategy", body: "How Northstar sounds in public." },
  { title: "Northstar 2026", category: "strategy", body: "The three-year view." },
  {
    title: "2026 success measures",
    category: "strategy",
    parent: "Northstar 2026",
    body: "What we will hold ourselves to.",
  },
  {
    title: "Positioning principles",
    category: "strategy",
    parent: "Northstar 2026",
    body: "Where we stand against the alternatives.",
  },
  {
    title: "Beta launch retrospective",
    category: "product",
    body: "What the private beta taught us.",
  },
  {
    title: "Launch decisions",
    category: "product",
    parent: "Spring launch narrative",
    body: "Decisions and the reasoning behind them.",
  },
  {
    title: "Messaging matrix",
    category: "product",
    parent: "Spring launch narrative",
    body: "One message per audience.",
  },
  { title: "Studio critique board", category: "design", body: "Weekly critique notes." },
  {
    title: "Vektor design language",
    category: "design",
    body: "The system behind the interface.",
  },
  {
    title: "Interaction principles",
    category: "design",
    parent: "Vektor design language",
    body: "How the interface should feel.",
  },
  {
    title: "Visual foundations",
    category: "design",
    parent: "Vektor design language",
    body: "Type, colour, and spacing.",
  },
  {
    title: "Interview 08 · Creative directors",
    category: "research",
    body: "Notes from the eighth interview.",
  },
  { title: "Signals digest", category: "research", body: "What we heard this month." },
  {
    title: "Decision record template",
    category: "operations",
    body: "Copy this for every significant decision.",
  },
];

/**
 * The database shot: a launch roadmap with the columns a planning table needs.
 *
 * The columns are inferred from the rows rather than declared in a `_schema`
 * property. Declaring it is the more explicit option and would fix the column
 * types too, but the home view's teaser card prints every property a document
 * has — `DocumentTeaser`'s `docTags` does not apply `isHiddenDocumentPropertyKey`
 * — so the schema JSON ends up spread across the card in the workspace shot.
 * Inference uses each key as its own heading and orders the columns
 * alphabetically, which is why these are capitalised and why the date column is
 * "Target date" rather than "Due": it puts the columns in reading order without
 * a schema to declare one. Same table, nothing to leak.
 */
const ROADMAP = {
  title: "Launch roadmap",
  category: "product",
  rows: [
    {
      title: "Public hosted beta",
      Owner: "Maya Chen",
      Status: "In progress",
      Priority: "P0",
      "Target date": "2026-04-18",
    },
    {
      title: "Canvas multiplayer polish",
      Owner: "Leo Martins",
      Status: "Review",
      Priority: "P0",
      "Target date": "2026-04-09",
    },
    {
      title: "Database saved views",
      Owner: "Iris Okafor",
      Status: "Planned",
      Priority: "P1",
      "Target date": "2026-04-24",
    },
    {
      title: "Extension developer guide",
      Owner: "Noah Williams",
      Status: "In progress",
      Priority: "P1",
      "Target date": "2026-04-15",
    },
    {
      title: "Launch performance pass",
      Owner: "Amara Singh",
      Status: "Ready",
      Priority: "P1",
      "Target date": "2026-04-11",
    },
    {
      title: "Onboarding templates",
      Owner: "Sofia Rossi",
      Status: "Exploring",
      Priority: "P2",
      "Target date": "2026-05-02",
    },
  ],
};

/**
 * The canvas shot: a launch story mapped into three framed columns.
 *
 * Laid out in world coordinates centred on the origin, because the canvas
 * auto-fits its camera to the content's bounding box on load — so the framing
 * follows from the geometry rather than from a pan the script would have to
 * replay. Sizes are literal for the same reason the ids below are.
 */
const COLUMN = { width: 420, height: 350, gap: 60, top: -180 };
const NOTE = { width: 190, height: 110 };

const STORY: {
  title: string;
  /** A section accent from the toolbar's swatch. */
  color: string;
  notes: { color: string; heading: string; body: string }[];
}[] = [
  {
    title: "01 · The tension",
    color: "#f472b6",
    notes: [
      {
        color: "#fee2e2",
        heading: "Context breaks",
        body: "Notes, boards, and trackers drift apart after every handoff.",
      },
      {
        color: "#fef3c7",
        heading: "Ownership fades",
        body: "Teams cannot see where decisions came from or who can act.",
      },
      {
        color: "#fae8ff",
        heading: "Creative history disappears",
        body: "The path to the final idea is lost.",
      },
    ],
  },
  {
    title: "02 · The promise",
    color: "#60a5fa",
    notes: [
      {
        color: "#dbeafe",
        heading: "One workspace",
        body: "Documents, data, and canvases stay connected.",
      },
      {
        color: "#fae8ff",
        heading: "Built together",
        body: "Presence, comments, and history live beside the work.",
      },
      {
        color: "#dcfce7",
        heading: "Yours to extend",
        body: "Self-host, automate, and build on an open foundation.",
      },
    ],
  },
  {
    title: "03 · The proof",
    color: "#34d399",
    notes: [
      {
        color: "#dcfce7",
        heading: "Write",
        body: "Capture the narrative and decisions with rich documents.",
      },
      {
        color: "#dbeafe",
        heading: "Structure",
        body: "Turn the plan into rows, properties, and workflows.",
      },
      {
        color: "#fef3c7",
        heading: "Explore",
        body: "Map the uncertain parts visually before they become a plan.",
      },
    ],
  },
];

/**
 * A note's stored text is markdown — the editor runs it through
 * `renderMessageMarkdown` on the way in — so the heading is emphasis the editor
 * renders, not markup, and not a first line the reader has to infer. HTML here
 * would show up in the shot as literal angle brackets.
 */
function noteMarkdown(heading: string, body: string): string {
  return `**${heading}**\n\n${body}`;
}

/**
 * Builds the canvas document's content.
 *
 * Ids and `updatedAt` are derived from the position rather than generated: the
 * canvas sorts shapes by `updatedAt` and paints selection chrome per id, so
 * either one varying would move pixels between runs for no reason.
 */
function buildCanvasContent(): string {
  const shapes: unknown[] = [];
  const span = STORY.length * COLUMN.width + (STORY.length - 1) * COLUMN.gap;
  const left = -span / 2;
  let clock = 1_000;

  shapes.push({
    id: "shape-story-title",
    type: "text",
    frame: { x: left, y: COLUMN.top - 90, width: 700, height: 48, rotation: 0 },
    style: { color: "transparent" },
    data: { text: "From scattered work to shared momentum", fontScale: 1 },
    updatedAt: (clock += 1_000),
  });

  for (const [index, column] of STORY.entries()) {
    const x = left + index * (COLUMN.width + COLUMN.gap);

    shapes.push({
      id: `shape-section-${index}`,
      type: "section",
      frame: {
        x,
        y: COLUMN.top,
        width: COLUMN.width,
        height: COLUMN.height,
        rotation: 0,
      },
      style: { color: column.color },
      data: { text: column.title },
      updatedAt: (clock += 1_000),
    });

    // Two across, one beneath — the shape a column of three takes when the
    // section is wide enough for a pair.
    for (const [slot, note] of column.notes.entries()) {
      shapes.push({
        id: `shape-note-${index}-${slot}`,
        type: "note",
        frame: {
          x: x + 10 + (slot % 2) * (NOTE.width + 20),
          y: COLUMN.top + 60 + Math.floor(slot / 2) * (NOTE.height + 30),
          width: NOTE.width,
          height: NOTE.height,
          rotation: 0,
        },
        style: { color: note.color },
        data: { text: noteMarkdown(note.heading, note.body) },
        updatedAt: (clock += 1_000),
      });
    }
  }

  return JSON.stringify({ version: 1, shapes, strokes: [] });
}

/**
 * What the home view's "Recently Modified" row should show, most recent first.
 *
 * One of each format the website advertises, then two supporting pages, so the
 * row reads as a workspace in use rather than a list of whatever was written last.
 */
const FEATURED: { title: string; category: string }[] = [
  { title: "Spring launch narrative", category: "product" },
  { title: "Launch story map", category: "design" },
  { title: "Launch roadmap", category: "product" },
  { title: "Positioning principles", category: "strategy" },
  { title: "Visual foundations", category: "design" },
];

/**
 * Fixes the order of the home view's recent documents.
 *
 * Seeding alone does not: `updatedAt` is stored in whole seconds, so documents
 * written in the same second tie, and the listing breaks that tie on a random
 * per-run id — which reshuffles the row between otherwise identical runs. Touching
 * the featured documents in reverse, a second apart, gives the head of the list
 * timestamps that cannot tie.
 *
 * The patch re-sends each document's existing category. Any property write bumps
 * `updatedAt`, and re-sending the value it already has changes nothing visible;
 * the title is deliberately left alone, since patching it can rename the slug the
 * shots navigate by.
 */
async function featureOnHome(
  api: string,
  spaceId: string,
  byTitle: ReadonlyMap<string, string>,
): Promise<void> {
  for (const featured of [...FEATURED].reverse()) {
    const id = byTitle.get(featured.title);
    if (!id) throw new Error(`cannot feature "${featured.title}": never created`);

    // Just over a second, and *before* the write rather than after: the column's
    // resolution is what is being stepped past, and the first touch has to clear
    // the second the last documents were created in as well as its own.
    await Bun.sleep(1_050);

    const response = await fetch(`${api}/spaces/${spaceId}/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { category: featured.category } }),
    });
    if (!response.ok) {
      throw new Error(`PATCH ${featured.title} -> ${response.status}`);
    }
  }
}

export interface Seeded {
  space: string;
  narrative: string;
  canvas: string;
  roadmap: string;
  /**
   * What the sidebar should have open, as the ids the tree persists.
   *
   * The shots want the tree showing its documents, and the tree remembers that
   * per browser under `wiki-expanded-items`. Seeding that entry is steadier than
   * clicking each disclosure open: nothing to wait for, and no gesture to re-tune
   * when the control moves. The ids are generated per run, so they have to be
   * collected here rather than written as literals.
   */
  expanded: string[];
}

/**
 * Fills an empty server with the fixture.
 *
 * Written through the public API rather than the store, so the seed exercises
 * the same validation a real editor would and cannot drift into a shape the app
 * refuses to render.
 */
async function seed(baseUrl: string): Promise<Seeded> {
  const api = `${baseUrl}/api/v1`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${api}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path} -> ${response.status} ${await response.text()}`);
    }
    return response.json();
  };

  const { space } = await post("/spaces", SPACE);

  const expanded: string[] = [];
  for (const definition of CATEGORIES) {
    const { category } = await post(`/spaces/${space.id}/categories`, definition);
    expanded.push(category.id);
  }

  const createDocument = async (body: Record<string, unknown>) => {
    const { document } = await post(`/spaces/${space.id}/documents`, body);
    return document as { id: string; slug: string };
  };

  // Created first because two supporting pages are filed underneath it.
  const narrative = await createDocument({
    type: "document",
    content: NARRATIVE_HTML,
    properties: { title: "Spring launch narrative", category: "product" },
  });

  const canvas = await createDocument({
    type: "canvas",
    content: buildCanvasContent(),
    properties: { title: "Launch story map", category: "design" },
  });

  // An empty body would be rejected — the API requires content to be a non-empty
  // string — and a database keeps its rows in child documents, not in its own
  // body, so there is nothing meaningful to put here.
  const EMPTY_BODY = "<p></p>";

  const roadmap = await createDocument({
    type: "database",
    content: EMPTY_BODY,
    properties: { title: ROADMAP.title, category: ROADMAP.category },
  });

  for (const row of ROADMAP.rows) {
    await createDocument({
      type: "record",
      content: EMPTY_BODY,
      parentId: roadmap.id,
      properties: { ...row },
    });
  }

  const byTitle = new Map<string, string>([
    ["Spring launch narrative", narrative.id],
    ["Launch story map", canvas.id],
    [ROADMAP.title, roadmap.id],
  ]);
  // Two passes so a child never looks up a parent that has not been created yet,
  // which keeps `PAGES` free to read in tree order rather than dependency order.
  for (const page of PAGES.filter((page) => !page.parent)) {
    const created = await createDocument({
      type: "document",
      content: `<h1>${page.title}</h1><p>${page.body}</p>`,
      properties: { title: page.title, category: page.category },
    });
    byTitle.set(page.title, created.id);
  }
  for (const page of PAGES.filter((page) => page.parent)) {
    const parentId = byTitle.get(page.parent as string);
    if (!parentId) throw new Error(`unknown parent "${page.parent}" for "${page.title}"`);
    const created = await createDocument({
      type: "document",
      content: `<h1>${page.title}</h1><p>${page.body}</p>`,
      parentId,
      properties: { title: page.title, category: page.category },
    });
    byTitle.set(page.title, created.id);
  }

  await featureOnHome(api, space.id, byTitle);

  // The pages that have children of their own; without these the tree shows the
  // branches but not that they nest.
  for (const title of ["Northstar 2026", "Vektor design language"]) {
    const id = byTitle.get(title);
    if (!id) throw new Error(`expected "${title}" to have been created`);
    expanded.push(id);
  }
  expanded.push(narrative.id);

  return {
    space: space.slug,
    narrative: narrative.slug,
    canvas: canvas.slug,
    roadmap: roadmap.slug,
    expanded,
  };
}

/**
 * Rebuilds what the server serves, since a stale embedded manifest fails to boot.
 *
 * `#build` is imported dynamically because its module body *is* the build, so a
 * static import would compile even when `VEKTOR_SKIP_BUILD` asked not to.
 */
async function buildClient(): Promise<void> {
  const build = Bun.spawn(["bunx", "--bun", "astro", "build"], {
    cwd: APP_DIR,
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("astro build failed");
  await import("#build");
}

/**
 * Puts the browser in a known state before the app's first line runs.
 *
 * The theme is written three ways because the app honours all three and they
 * must not disagree: the stored preference the profile menu reads, the
 * `data-theme` attribute the stylesheets key off, and — through the context's
 * `colorScheme` — the media query the "system" default falls back to. Setting
 * the attribute here rather than waiting for the app to apply it also removes
 * the light flash a capture could otherwise catch.
 */
function primeBrowser(state: {
  theme: Theme;
  themeKey: string;
  tourKey: string;
  expanded: string[];
}): void {
  try {
    localStorage.setItem(state.themeKey, state.theme);
    localStorage.setItem("wiki-expanded-items", JSON.stringify(state.expanded));
    // A first-run browser opens the document-organization tour over the whole
    // page, which is what every shot would otherwise be a picture of.
    localStorage.setItem(state.tourKey, "true");
  } catch {
    // Storage blocked — the shot still renders, just with the app's defaults.
  }
  document.documentElement.setAttribute("data-theme", state.theme);
}

async function capture(browser: Browser, seeded: Seeded, theme: Theme): Promise<void> {
  const context = await browser.newContext({
    baseURL: testBaseUrl(PORT),
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: theme,
    locale: "en-US",
    timezoneId: "UTC",
    // A shot of a half-played transition is the one thing a re-run must not
    // differ by.
    reducedMotion: "reduce",
  });
  await context.addInitScript(primeBrowser, {
    theme,
    themeKey: THEME_STORAGE_KEY,
    tourKey: ORGANIZATION_TOUR_KEY,
    expanded: seeded.expanded,
  });

  const page = await context.newPage();

  for (const shot of SHOTS) {
    await page.goto(shot.path(seeded));
    // The tree loads its documents per expanded category, independently of the
    // main view, so a shot gated only on its own content can still catch the
    // sidebar mid-skeleton. This names a leaf, which is the last thing to arrive.
    await page
      .locator("nav")
      .getByText("Positioning principles")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.locator(shot.ready).first().waitFor({ state: "visible", timeout: 30_000 });
    // Web fonts land after first paint, and a shot taken between the fallback
    // and the real face has visibly different metrics.
    await page.evaluate(() => document.fonts.ready);
    if (shot.settleMs) await page.waitForTimeout(shot.settleMs);
    if (shot.prepare) {
      await shot.prepare(page);
      await page.waitForTimeout(600);
    }

    const png = await page.screenshot({ animations: "disabled", caret: "hide" });
    // Width and height stay at 0: this re-encodes, it does not resize.
    const webp = transform(png, { w: 0, h: 0, format: "webp", quality: QUALITY });
    const file = `${shot.name}-${theme}.webp`;
    await Bun.write(`${OUT_DIR}/${file}`, webp);
    console.log(`  ${file}  (${Math.round(webp.length / 1024)} KB)`);
  }

  await context.close();
}

// Checked before the build rather than after, so a missing checkout costs a
// second instead of a full boot-and-shoot.
if (!existsSync(OUT_DIR)) {
  throw new Error(
    `website image directory not found: ${OUT_DIR}\n` +
      "Check the website out beside this repo, or set VEKTOR_WEBSITE_IMAGES.",
  );
}

const baseUrl = testBaseUrl(PORT);

if (process.env.VEKTOR_SKIP_BUILD !== "1") {
  console.log("building client…");
  await buildClient();
}

const server = startTestServer(PORT, {
  VEKTOR_NO_AUTH: "1",
  VEKTOR_IN_MEMORY_DB: "1",
  VEKTOR_SITE_URL: baseUrl,
  VEKTOR_API_URL: baseUrl,
});
const stop = () => {
  try {
    server.kill();
  } catch {
    // already gone
  }
};
process.on("exit", stop);
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

await waitForServer(baseUrl, 60_000);
console.log("seeding…");
const seeded = await seed(baseUrl);

const browser = await chromium.launch();
for (const theme of THEMES) {
  await capture(browser, seeded, theme);
}
await browser.close();
stop();

console.log(`\nwrote ${SHOTS.length * THEMES.length} screenshots to ${OUT_DIR}`);
process.exit(0);
