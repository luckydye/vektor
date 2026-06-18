/**
 * Tests for image transform + cache logic.
 *
 * Unit suite:  parseTransformParams, transformCachePath — no server required.
 * Integration: full route — spins up an isolated server, uploads a real PNG,
 *              exercises resize / format-convert / upscale-guard / cache-hit.
 *
 * Run with:
 *   bun test test/transforms.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import sharp from "sharp";
import { parseTransformParams, transformCachePath, withTransformParams } from "../src/files/transforms.ts";

// ---------------------------------------------------------------------------
// Unit — withTransformParams
// ---------------------------------------------------------------------------

describe("withTransformParams", () => {
  const uploadUrl = "/api/v1/spaces/space_1/uploads/ab/abc123.jpg";

  it("appends params to an internal upload URL", () => {
    const result = withTransformParams(uploadUrl, { w: 1600, format: "webp", q: 85 });
    expect(result).toBe(`${uploadUrl}?w=1600&format=webp&q=85`);
  });

  it("returns external URLs unchanged", () => {
    const ext = "https://example.com/photo.jpg";
    expect(withTransformParams(ext, { w: 1600 })).toBe(ext);
  });

  it("returns SVG URLs unchanged (not transformable)", () => {
    const svg = "/api/v1/spaces/space_1/uploads/ab/abc123.svg";
    expect(withTransformParams(svg, { w: 1600, format: "webp" })).toBe(svg);
  });

  it("returns non-image upload URLs unchanged", () => {
    const pdf = "/api/v1/spaces/space_1/uploads/ab/abc123.pdf";
    expect(withTransformParams(pdf, { w: 1600 })).toBe(pdf);
  });

  it("omits params with no values provided", () => {
    const result = withTransformParams(uploadUrl, {});
    expect(result).toBe(uploadUrl);
  });

  it("only includes params that are set", () => {
    const result = withTransformParams(uploadUrl, { format: "webp" });
    expect(result).toBe(`${uploadUrl}?format=webp`);
  });
});

// ---------------------------------------------------------------------------
// Unit — parseTransformParams
// ---------------------------------------------------------------------------

describe("parseTransformParams", () => {
  it("returns null for non-image extensions", () => {
    expect(parseTransformParams(new URLSearchParams("w=100"), "pdf")).toBeNull();
    expect(parseTransformParams(new URLSearchParams("w=100"), "mp4")).toBeNull();
    expect(parseTransformParams(new URLSearchParams("w=100"), "txt")).toBeNull();
  });

  it("returns null when no recognised params are present", () => {
    expect(parseTransformParams(new URLSearchParams(""), "png")).toBeNull();
    expect(parseTransformParams(new URLSearchParams("foo=bar"), "jpg")).toBeNull();
  });

  it("parses w", () => {
    const p = parseTransformParams(new URLSearchParams("w=800"), "jpg");
    expect(p).not.toBeNull();
    expect(p!.w).toBe(800);
    expect(p!.h).toBe(0);
  });

  it("parses h", () => {
    const p = parseTransformParams(new URLSearchParams("h=600"), "png");
    expect(p!.h).toBe(600);
    expect(p!.w).toBe(0);
  });

  it("parses format", () => {
    const p = parseTransformParams(new URLSearchParams("format=webp"), "jpg");
    expect(p!.format).toBe("webp");
  });

  it("rejects unknown format values and returns null (no other params)", () => {
    expect(parseTransformParams(new URLSearchParams("format=avif"), "jpg")).toBeNull();
    expect(parseTransformParams(new URLSearchParams("format=bmp"), "jpg")).toBeNull();
  });

  it("parses q and applies default of 80 when absent", () => {
    const withQ = parseTransformParams(new URLSearchParams("w=100&q=60"), "jpg");
    expect(withQ!.quality).toBe(60);

    const noQ = parseTransformParams(new URLSearchParams("w=100"), "jpg");
    expect(noQ!.quality).toBe(80);
  });

  it("clamps quality to 1–100", () => {
    const lo = parseTransformParams(new URLSearchParams("w=1&q=0"), "jpg");
    expect(lo!.quality).toBe(1);

    const hi = parseTransformParams(new URLSearchParams("w=1&q=200"), "jpg");
    expect(hi!.quality).toBe(100);
  });

  it("q alone is sufficient to trigger a transform", () => {
    const p = parseTransformParams(new URLSearchParams("q=50"), "jpg");
    expect(p).not.toBeNull();
    expect(p!.quality).toBe(50);
  });

  it("returns null for NaN w or h", () => {
    expect(parseTransformParams(new URLSearchParams("w=abc"), "jpg")).toBeNull();
    expect(parseTransformParams(new URLSearchParams("h=abc"), "jpg")).toBeNull();
  });

  it("is case-insensitive on extension", () => {
    expect(parseTransformParams(new URLSearchParams("w=100"), "PNG")).not.toBeNull();
    expect(parseTransformParams(new URLSearchParams("w=100"), "JPG")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit — transformCachePath
// ---------------------------------------------------------------------------

describe("transformCachePath", () => {
  it("produces the expected path format", () => {
    const p = transformCachePath("space1", "ab/abc123.png", {
      w: 800,
      h: 0,
      format: "webp",
      quality: 80,
    });
    expect(p).toContain("data/transforms/space1/ab/abc123.png");
    expect(p).toContain("_800x0_webp_q80.webp");
  });

  it("uses 'orig' when format is null", () => {
    const p = transformCachePath("space1", "ab/abc123.png", {
      w: 0,
      h: 0,
      format: null,
      quality: 80,
    });
    expect(p).toContain("_orig_");
  });

  it("uses jpg extension (not jpeg) in the cache filename for jpeg format", () => {
    const p = transformCachePath("space1", "ab/abc123.png", {
      w: 0,
      h: 0,
      format: "jpeg",
      quality: 80,
    });
    expect(p).toEndWith(".jpg");
  });

  it("preserves the original extension when format is null", () => {
    const p = transformCachePath("space1", "ab/abc123.png", {
      w: 0,
      h: 0,
      format: null,
      quality: 80,
    });
    expect(p).toEndWith(".png");
  });
});

// ---------------------------------------------------------------------------
// Integration — full route
// ---------------------------------------------------------------------------

const PORT = 7483;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess: ReturnType<typeof Bun.spawn>;
let spaceId: string;

/** A 100 × 200 solid-red PNG generated at test startup. */
let testPngBuffer: Buffer;

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/spaces`);
      if (res.status < 500) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/** Upload a file and return its key. */
async function uploadFile(
  sid: string,
  filename: string,
  buffer: Buffer,
  mime: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${BASE_URL}/api/v1/spaces/${sid}/uploads`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { key: string };
  return data.key;
}

beforeAll(async () => {
  // Generate test image: 100 wide × 200 tall, solid red
  testPngBuffer = await sharp({
    create: { width: 100, height: 200, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();

  serverProcess = Bun.spawn(["bun", "./src/server.ts", "--port", String(PORT)], {
    env: {
      ...process.env,
      VEKTOR_NO_AUTH: "1",
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_API_ONLY: "1",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      VEKTOR_OTEL_ENABLED: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
    cwd: import.meta.dir + "/..",
  });

  await waitForServer();

  const { space } = await apiJson<{ space: { id: string } }>("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Transform Test", slug: "transform-test" }),
  });
  spaceId = space.id;
});

afterAll(() => {
  serverProcess?.kill();
});

describe("image transforms — integration", () => {
  let imageKey: string;

  beforeAll(async () => {
    imageKey = await uploadFile(spaceId, "test.png", testPngBuffer, "image/png");
  });

  it("serves the original image when no transform params are given", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(200);
  });

  it("resizes the image with ?w=50 (preserves aspect ratio)", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?w=50`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(100);
  });

  it("resizes with ?h=50 (preserves aspect ratio)", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?h=50`,
    );
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.height).toBe(50);
    expect(meta.width).toBe(25);
  });

  it("converts to webp with ?format=webp", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?format=webp`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe("webp");
  });

  it("does not enlarge the image when ?w exceeds the original width", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?w=9999`,
    );
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(buf).metadata();
    // Must not exceed original 100 × 200
    expect(meta.width).toBeLessThanOrEqual(100);
    expect(meta.height).toBeLessThanOrEqual(200);
  });

  it("returns the cached transform on a repeated request (same bytes)", async () => {
    const url = `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?w=40&format=webp`;

    const first = await fetch(url);
    const firstBytes = Buffer.from(await first.arrayBuffer());

    const second = await fetch(url);
    const secondBytes = Buffer.from(await second.arrayBuffer());

    expect(second.status).toBe(200);
    expect(secondBytes.equals(firstBytes)).toBe(true);
  });

  it("serves a gif with correct Content-Type when no format conversion is requested", async () => {
    // Generate a minimal 1x1 GIF
    const gifBuffer = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 128, b: 0 } },
    })
      .gif()
      .toBuffer();
    const gifKey = await uploadFile(spaceId, "tiny.gif", gifBuffer, "image/gif");

    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${gifKey}?w=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/gif");
  });

  it("does not advertise Accept-Ranges on transformed responses", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?w=50`,
    );
    expect(res.headers.get("Accept-Ranges")).toBeNull();
  });

  it("ignores transform params for non-image files and serves them as-is", async () => {
    const txtBuffer = Buffer.from("hello world");
    const txtKey = await uploadFile(spaceId, "readme.txt", txtBuffer, "text/plain");

    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${txtKey}?w=100&format=webp`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toBe("hello world");
  });
});
