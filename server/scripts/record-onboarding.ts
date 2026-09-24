/**
 * Films the onboarding tour's clips against the real application.
 *
 * Drawn mockups would be a second implementation of the sidebar that drifts as the
 * real one changes; recording it makes a re-record after a redesign one command.
 * Reuses the e2e rig, so nothing here touches a developer's own database.
 *
 *   bun ./scripts/record-onboarding.ts              # build, boot, record, encode
 *   VEKTOR_SKIP_BUILD=1 bun ./scripts/record-onboarding.ts
 *   bun ./scripts/record-onboarding.ts --keep-frames  # keep the captured frames
 */
import { chromium, type Page } from "@playwright/test";
import { startTestServer, testBaseUrl, waitForServer } from "#test/helpers/server.ts";
import { ORGANIZATION_TOUR_KEY } from "#utils/onboarding.ts";

const PORT = Number(process.env.VEKTOR_RECORD_PORT ?? 4399);
const APP_DIR = new URL("..", import.meta.url).pathname;
const FRAME_DIR = `${APP_DIR}scripts/.onboarding-frames`;
const OUT_DIR = `${APP_DIR}public/onboarding`;

const VIEWPORT = { width: 1280, height: 860 };

/**
 * Why the frames are screenshots rather than a recording.
 *
 * A clipped `page.screenshot` is the only capture that honours
 * `deviceScaleFactor`: `recordVideo` and the CDP screencast both hand back 1×
 * frames, and `zoom: 2` misplaces the category menu, which is positioned from
 * `event.clientX`. The cost is one frame per round trip — see `film`.
 */
const SCALE = 2;

/**
 * The framed region, in CSS pixels.
 *
 * Wider than the sidebar because the category menu opens past its edge. Filmed on
 * a document page, whose editor leaves that extra strip quiet.
 */
const CROP = { width: 470, height: 280 };

/** Distance from the first category row to the crop's top-left, in CSS pixels. */
const CROP_INSET = { x: 12, y: 36 };

/** Slow enough to read, short enough that a loop does not feel like a wait. */
const STEP_MS = 34;
const DRAG_STEPS = 26;

const OUTPUT_FPS = 30;

interface Clip {
  name: string;
  /** Categories to expand before filming, by name. */
  expand: string[];
  run: (ui: Ui) => Promise<void>;
}

const CLIPS: Clip[] = [
  {
    // Filing: a document belongs to one category, and moving it there is a drag
    // onto the category row.
    name: "categories",
    expand: ["Guides", "Reference"],
    run: async (ui) => {
      await ui.dragTo(ui.document("Deploying"), ui.category("Guides"));
      await ui.settle();
    },
  },
  {
    // Nesting: dropping a document on another document makes it a child, which is
    // how a page grows sub-pages.
    name: "nesting",
    expand: ["Guides"],
    run: async (ui) => {
      await ui.dragTo(ui.document("Installation"), ui.document("Getting started"));
      await ui.settle();
      // The new parent collapses its children, so without this the clip ends on a
      // row that simply disappeared.
      await ui.click(
        ui.document("Getting started").getByRole("button", { name: "Expand" }),
      );
      await ui.settle();
    },
  },
  {
    // Ordering: the categories themselves are draggable, but only in the mode the
    // options menu turns on — worth showing, because nothing else reveals it.
    name: "rearrange",
    expand: [],
    run: async (ui) => {
      await ui.click(ui.categoryMenuButton("Guides"));
      await ui.pause(600);
      await ui.click(ui.button("Rearrange categories"));
      await ui.pause(500);
      await ui.dragTo(ui.category("Reference"), ui.category("Guides"));
      await ui.pause(500);
      // Reads "Done"; the accessible name comes from the button's own aria-label.
      await ui.click(ui.button("Done rearranging"));
      await ui.settle();
    },
  },
];

/**
 * A pointer the recording can actually show, since captures contain no cursor.
 *
 * Tracks the native drag events as well as the pointer ones, because `mousemove`
 * stops firing the moment a drag begins.
 */
function installStandInCursor(): void {
  const cursor = document.createElement("div");
  cursor.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:20px",
    "height:20px",
    "z-index:2147483647",
    "pointer-events:none",
    "opacity:0",
    "transition:opacity 150ms linear",
    "will-change:transform",
  ].join(";");
  cursor.innerHTML =
    '<svg viewBox="0 0 20 20" width="20" height="20">' +
    '<path d="M3 1.5 L3 15 L6.6 11.8 L9.2 17.6 L11.7 16.5 L9.2 10.8 L13.9 10.6 Z"' +
    ' fill="#111827" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  let pressed = false;

  const place = (event: Event) => {
    const point = event as MouseEvent;
    if (typeof point.clientX !== "number") return;
    if (!point.clientX && !point.clientY) return;
    cursor.style.opacity = "1";
    cursor.style.transform = `translate(${point.clientX - 3}px,${point.clientY - 2}px) scale(${pressed ? 0.85 : 1})`;
  };

  const press = (value: boolean) => (event: Event) => {
    pressed = value;
    place(event);
  };

  const attach = () => {
    document.body.appendChild(cursor);
    for (const type of ["pointermove", "mousemove", "drag", "dragover"]) {
      document.addEventListener(type, place, { capture: true, passive: true });
    }
    for (const type of ["pointerdown", "dragstart"]) {
      document.addEventListener(type, press(true), true);
    }
    for (const type of ["pointerup", "dragend", "drop"]) {
      document.addEventListener(type, press(false), true);
    }
  };

  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach, { once: true });
}

type Target = ReturnType<Page["locator"]>;

interface Point {
  x: number;
  y: number;
}

interface Ui {
  page: Page;
  button: (name: string) => Target;
  category: (name: string) => Target;
  categoryMenuButton: (name: string) => Target;
  document: (title: string) => Target;
  glide: (to: Point, steps: number) => Promise<void>;
  click: (target: Target) => Promise<void>;
  dragTo: (from: Target, to: Target) => Promise<void>;
  /** Holds still, but keeps filming — a plain wait would be a gap in the clip. */
  pause: (ms: number) => Promise<void>;
  settle: () => Promise<void>;
  park: (at: Point) => void;
}

async function centre(target: Target): Promise<Point> {
  await target.waitFor({ state: "visible", timeout: 15_000 });
  const box = await target.boundingBox();
  if (!box) throw new Error("target has no geometry");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function makeUi(page: Page, camera: { film: (ms: number) => Promise<void> }): Ui {
  const tree = page.locator("nav");

  const category = (name: string) =>
    tree.locator("category-target").filter({ hasText: name }).first();

  // Playwright does not report where the mouse is, so the stand-in cursor's path
  // has to be interpolated from a position tracked here.
  let pointer: Point = { x: 0, y: 0 };

  const ui: Ui = {
    page,
    category,
    button: (name: string) => page.getByRole("button", { name, exact: true }).first(),
    categoryMenuButton: (name: string) =>
      category(name).getByRole("button", { name: "Category options" }),
    // The row is the drag source, not the link inside it, so the whole row is
    // what the gesture grabs.
    document: (title: string) =>
      tree.locator("page-target").filter({ hasText: title }).first(),

    async glide(to, steps) {
      // `mouse.move`'s own `steps` dispatches the path as fast as the protocol
      // allows, which films as a jump.
      const from = { ...pointer };
      for (let step = 1; step <= steps; step++) {
        const progress = step / steps;
        pointer = {
          x: from.x + (to.x - from.x) * progress,
          y: from.y + (to.y - from.y) * progress,
        };
        await page.mouse.move(pointer.x, pointer.y);
        await camera.film(STEP_MS);
      }
    },

    async click(target) {
      await ui.glide(await centre(target), 12);
      await ui.pause(240);
      await page.mouse.down();
      await ui.pause(120);
      await page.mouse.up();
    },

    async dragTo(from, to) {
      await ui.glide(await centre(from), 12);
      await ui.pause(320);
      await page.mouse.down();
      await ui.pause(160);
      // Measured after the grab, because the source row changes on `dragstart`.
      await ui.glide(await centre(to), DRAG_STEPS);
      await ui.pause(260);
      await page.mouse.up();
    },

    pause: (ms) => camera.film(ms),
    // Long enough for the optimistic update, the API round trip and the tree's
    // expand animation to finish, so the clip ends on the result.
    settle: () => camera.film(1400),
    park: (at) => {
      pointer = at;
    },
  };

  return ui;
}

interface Frame {
  data: Buffer;
  /** How long this frame should be held, in seconds. */
  duration: number;
}

/**
 * Films a region of the page, one screenshot at a time.
 *
 * `film(ms)` shoots for `ms` and then divides `ms` between the frames it got:
 * charging each frame what it cost to take would play the clip in slow motion.
 */
function makeCamera(page: Page, clip: Point) {
  const frames: Frame[] = [];
  const region = { ...clip, width: CROP.width, height: CROP.height };

  return {
    frames,
    async film(ms: number): Promise<void> {
      const deadline = Date.now() + ms;
      const shot: Frame[] = [];
      do {
        const data = await page.screenshot({
          clip: region,
          scale: "device",
          // Playwright would otherwise pause CSS animations and hide the caret to
          // make screenshots comparable, which is the opposite of the intent here.
          animations: "allow",
          caret: "initial",
        });
        shot.push({ data, duration: 0 });
      } while (Date.now() < deadline);

      for (const frame of shot) frame.duration = ms / shot.length / 1000;
      frames.push(...shot);
    },
  };
}

/**
 * Encodes the filmed frames, which are already cropped and scaled.
 *
 * The concat demuxer carries each frame's own duration, so the pauses that make a
 * gesture readable survive the fixed output frame rate.
 */
async function encode(frames: Frame[], out: string): Promise<void> {
  if (frames.length < 2) throw new Error(`only ${frames.length} frames captured`);

  const name = out.split("/").pop()?.replace(".webm", "") ?? "clip";
  const dir = `${FRAME_DIR}/${name}`;
  await Bun.$`rm -rf ${dir}`.quiet();
  await Bun.$`mkdir -p ${dir}`.quiet();

  const lines: string[] = [];
  for (const [index, frame] of frames.entries()) {
    const path = `${dir}/${String(index).padStart(5, "0")}.png`;
    await Bun.write(path, frame.data);
    // A beat on the closing frame, so a loop reads as finished rather than cut.
    const duration = index === frames.length - 1 ? 0.8 : frame.duration;
    lines.push(`file '${path}'`, `duration ${duration.toFixed(4)}`);
  }
  // The concat demuxer drops the final entry unless the file is repeated.
  lines.push(`file '${dir}/${String(frames.length - 1).padStart(5, "0")}.png'`);
  await Bun.write(`${dir}/frames.txt`, `${lines.join("\n")}\n`);

  const ffmpeg = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      `${dir}/frames.txt`,
      "-vf",
      `fps=${OUTPUT_FPS}`,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "36",
      "-row-mt",
      "1",
      "-pix_fmt",
      "yuv420p",
      out,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await ffmpeg.exited) !== 0) throw new Error(`ffmpeg failed for ${out}`);
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
 * One space per clip.
 *
 * Every filmed gesture persists, so a shared space would make each clip start from
 * the previous one's result.
 */
async function seedSpace(
  baseUrl: string,
  slug: string,
): Promise<{ space: string; document: string }> {
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

  const { space } = await post("/spaces", { name: "Handbook", slug });

  // Created in this order because the tree lists categories by position, and the
  // rearrange clip drags the second one above the first.
  for (const category of [
    { name: "Guides", slug: "guides", color: "#2563eb" },
    { name: "Reference", slug: "reference", color: "#7c3aed" },
  ]) {
    await post(`/spaces/${space.id}/categories`, category);
  }

  const slugs = new Map<string, string>();
  for (const doc of [
    { title: "Getting started", category: "guides" },
    { title: "Installation", category: "guides" },
    { title: "Deploying", category: "reference" },
    { title: "API tokens", category: "reference" },
  ]) {
    const { document } = await post(`/spaces/${space.id}/documents`, {
      type: "document",
      content: `<p>${doc.title}</p>`,
      properties: { title: doc.title, category: doc.category },
    });
    slugs.set(doc.title, document.slug);
  }

  const opened = slugs.get("Getting started");
  if (!opened) throw new Error("seed did not return a document slug");
  return { space: space.slug, document: opened };
}

const baseUrl = testBaseUrl(PORT);
const keepFrames = Bun.argv.includes("--keep-frames");

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

await Bun.$`rm -rf ${FRAME_DIR}`.quiet();
await Bun.$`mkdir -p ${FRAME_DIR} ${OUT_DIR}`.quiet();

const browser = await chromium.launch();

for (const clip of CLIPS) {
  const seeded = await seedSpace(baseUrl, `handbook-${clip.name}`);

  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  });

  // The tour is what is being filmed; it must not film itself.
  await context.addInitScript((key) => {
    try {
      localStorage.setItem(key, "true");
    } catch {
      // Storage blocked — the dialog would appear, and the clip would show it.
    }
  }, ORGANIZATION_TOUR_KEY);
  await context.addInitScript(installStandInCursor);

  const page = await context.newPage();
  await page.goto(`/${seeded.space}/doc/${seeded.document}`);

  const guides = page
    .locator("nav")
    .locator("category-target")
    .filter({ hasText: "Guides" })
    .first();
  await guides.waitFor({ state: "visible", timeout: 30_000 });

  for (const name of clip.expand) {
    await page
      .locator("nav")
      .locator("category-target")
      .filter({ hasText: name })
      .first()
      .locator("button")
      .first()
      .click();
    await page.waitForTimeout(500);
  }
  // Documents arrive per category, and filming early would open on skeletons.
  await page.waitForTimeout(900);

  const treeBox = await guides.boundingBox();
  if (!treeBox) throw new Error("no sidebar geometry");
  const region = {
    x: Math.max(0, treeBox.x - CROP_INSET.x),
    y: Math.max(0, treeBox.y - CROP_INSET.y),
  };

  const camera = makeCamera(page, region);
  const ui = makeUi(page, camera);

  // Started in the corner so no row opens the clip in a hover state.
  const start = {
    x: region.x + CROP.width - 24,
    y: region.y + CROP.height - 16,
  };
  await page.mouse.move(start.x, start.y);
  ui.park(start);
  await ui.pause(300);

  await clip.run(ui);

  await context.close();
  await encode(camera.frames, `${OUT_DIR}/${clip.name}.webm`);
  console.log(`${clip.name}.webm  (${camera.frames.length} frames)`);
}

await browser.close();
if (!keepFrames) await Bun.$`rm -rf ${FRAME_DIR}`.quiet();
stop();
console.log(`\nwrote ${CLIPS.length} clips to public/onboarding/`);
process.exit(0);
