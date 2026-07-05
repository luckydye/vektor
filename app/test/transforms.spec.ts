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
import { getNativeImage } from "#files/native.ts";
import {
  parseTransformParams,
  transformCachePath,
  withTransformParams,
} from "#files/transforms.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const native = getNativeImage();
if (!native) {
  throw new Error(
    "native image addon unavailable — run: cd native/image && bun run build",
  );
}

/** Read width/height/format from encoded image bytes. */
function meta(buf: Buffer) {
  return native.metadata(buf);
}

// ---------------------------------------------------------------------------
// Unit — withTransformParams
// ---------------------------------------------------------------------------

describe("withTransformParams", () => {
  const uploadUrl = "/api/v1/spaces/space_1/uploads/ab/abc123.jpg";

  it("appends params to an internal upload URL", () => {
    const result = withTransformParams(uploadUrl, { w: 1600, format: "webp", q: 85 });
    expect(result).toBe(`${uploadUrl}?w=1600&format=webp&q=85`);
  });

  it("appends params to an absolute internal upload URL", () => {
    const absoluteUrl = `https://vektor.example${uploadUrl}`;
    const result = withTransformParams(absoluteUrl, { w: 1600, format: "webp", q: 85 });
    expect(result).toBe(`${absoluteUrl}?w=1600&format=webp&q=85`);
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

  it("parses w by snapping to the nearest preset dimension", () => {
    const p = parseTransformParams(new URLSearchParams("w=800"), "jpg");
    expect(p).not.toBeNull();
    expect(p!.w).toBe(640);
    expect(p!.h).toBe(0);
  });

  it("parses h by snapping to the nearest preset dimension", () => {
    const p = parseTransformParams(new URLSearchParams("h=600"), "png");
    expect(p!.h).toBe(640);
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

  it("uses fixed quality of 80 even when q is present", () => {
    const withQ = parseTransformParams(new URLSearchParams("w=100&q=60"), "jpg");
    expect(withQ!.quality).toBe(80);

    const noQ = parseTransformParams(new URLSearchParams("w=100"), "jpg");
    expect(noQ!.quality).toBe(80);
  });

  it("ignores out-of-range quality values", () => {
    const lo = parseTransformParams(new URLSearchParams("w=1&q=0"), "jpg");
    expect(lo!.quality).toBe(80);

    const hi = parseTransformParams(new URLSearchParams("w=1&q=200"), "jpg");
    expect(hi!.quality).toBe(80);
  });

  it("does not treat q alone as sufficient to trigger a transform", () => {
    const p = parseTransformParams(new URLSearchParams("q=50"), "jpg");
    expect(p).toBeNull();
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
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let spaceId: string;

/** A 100 × 200 solid-red PNG generated at test startup. */
let testPngBuffer: Buffer;

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await apiRequest(path, options);
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
  const data = (await res.json()) as { key: string; url: string };
  expect(data.url).toBe(`/api/v1/spaces/${sid}/uploads/${data.key}`);
  return data.key;
}

beforeAll(async () => {
  // Generate test image: 100 wide × 200 tall, solid red
  testPngBuffer = Buffer.from(native.encodeSolid(100, 200, 200, 50, 50, "png", 80));

  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
  });

  await waitForServer(BASE_URL);

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
    const m = meta(buf);
    expect(m.width).toBe(100);
    expect(m.height).toBe(200);
  });

  it("snaps ?w=50 to a preset and does not upscale past the original width", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?w=50`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");

    const buf = Buffer.from(await res.arrayBuffer());
    const m = meta(buf);
    expect(m.width).toBe(100);
    expect(m.height).toBe(200);
  });

  it("snaps ?h=50 to a preset and preserves aspect ratio", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?h=50`,
    );
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const m = meta(buf);
    expect(m.height).toBe(160);
    expect(m.width).toBe(80);
  });

  it("converts to webp with ?format=webp", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?format=webp`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");

    const buf = Buffer.from(await res.arrayBuffer());
    const m = meta(buf);
    expect(m.format).toBe("webp");
  });

  it("does not enlarge the image when ?w exceeds the original width", async () => {
    const res = await fetch(
      `${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${imageKey}?w=9999`,
    );
    expect(res.status).toBe(200);

    const buf = Buffer.from(await res.arrayBuffer());
    const m = meta(buf);
    // Must not exceed original 100 × 200
    expect(m.width).toBeLessThanOrEqual(100);
    expect(m.height).toBeLessThanOrEqual(200);
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
    const gifBuffer = Buffer.from(native.encodeSolid(1, 1, 0, 128, 0, "gif", 80));
    const gifKey = await uploadFile(spaceId, "tiny.gif", gifBuffer, "image/gif");

    const res = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/uploads/${gifKey}?w=1`);
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
