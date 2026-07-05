import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commandCategoryCreate,
  commandCategoryEdit,
  commandCategoryLs,
  commandCategoryRm,
} from "#cli/category.ts";
import { commandCreate, commandSet } from "#cli/document.ts";
import { commandUploadFile, toAbsoluteUrl } from "#cli/upload.ts";

const HOST = "https://vektor.example.com";
const SPACE_ID = "space-test-1";
const TMP = "/tmp/vektor-cli-spec";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(String(input), init)),
  );
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  return new Promise(async (resolve, reject) => {
    const written: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      await fn();
      resolve(written.join(""));
    } catch (err) {
      reject(err);
    } finally {
      spy.mockRestore();
    }
  });
}

function makeTempFile(name: string, content = "hello"): string {
  const p = join(TMP, name);
  writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  process.env.VEKTOR_HOST = HOST;
  process.env.VEKTOR_SPACE_ID = SPACE_ID;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.VEKTOR_HOST;
  delete process.env.VEKTOR_SPACE_ID;
  mock.restore();
});

// ---------------------------------------------------------------------------
// upload — toAbsoluteUrl
// ---------------------------------------------------------------------------

describe("toAbsoluteUrl", () => {
  test("prepends host to a relative path", () => {
    expect(toAbsoluteUrl(HOST, "/api/v1/spaces/s1/uploads/ab/abc.png")).toBe(
      `${HOST}/api/v1/spaces/s1/uploads/ab/abc.png`,
    );
  });

  test("strips trailing slash from host before joining", () => {
    expect(toAbsoluteUrl(`${HOST}/`, "/api/v1/spaces/s1/uploads/ab/abc.png")).toBe(
      `${HOST}/api/v1/spaces/s1/uploads/ab/abc.png`,
    );
  });

  test("returns already-absolute URLs unchanged", () => {
    const abs = "https://cdn.example.com/files/abc.png";
    expect(toAbsoluteUrl(HOST, abs)).toBe(abs);
  });
});

// ---------------------------------------------------------------------------
// upload — commandUploadFile
// ---------------------------------------------------------------------------

describe("commandUploadFile", () => {
  test("outputs the absolute URL in plain mode", async () => {
    mockFetch(() =>
      Response.json({
        key: "ab/abc123.png",
        url: `/api/v1/spaces/${SPACE_ID}/uploads/ab/abc123.png`,
      }),
    );

    const out = await captureStdout(() =>
      commandUploadFile({ source: makeTempFile("image.png") }),
    );

    expect(out).toBe(
      `ab/abc123.png\t${HOST}/api/v1/spaces/${SPACE_ID}/uploads/ab/abc123.png\n`,
    );
  });

  test("outputs absolute URL in --json mode", async () => {
    mockFetch(() =>
      Response.json({
        key: "cd/cdf456.pdf",
        url: `/api/v1/spaces/${SPACE_ID}/uploads/cd/cdf456.pdf`,
      }),
    );

    const out = await captureStdout(() =>
      commandUploadFile({ source: makeTempFile("doc.pdf"), json: true }),
    );

    const parsed = JSON.parse(out);
    expect(parsed.url).toBe(`${HOST}/api/v1/spaces/${SPACE_ID}/uploads/cd/cdf456.pdf`);
    expect(parsed.key).toBe("cd/cdf456.pdf");
  });

  test("leaves already-absolute URLs from the server untouched", async () => {
    const externalUrl = "https://cdn.example.com/files/xyz.mp4";
    mockFetch(() => Response.json({ key: "xy/xyz.mp4", url: externalUrl }));

    const out = await captureStdout(() =>
      commandUploadFile({ source: makeTempFile("video.mp4") }),
    );

    expect(out).toContain(externalUrl);
  });
});

// ---------------------------------------------------------------------------
// category — slug-first output
// ---------------------------------------------------------------------------

const CATEGORY = { id: "cat_abc123", name: "Engineering", slug: "engineering", order: 0 };

describe("commandCategoryCreate", () => {
  test("outputs slug then name — not the internal id", async () => {
    mockFetch(() => Response.json({ category: CATEGORY }));

    const out = await captureStdout(() => commandCategoryCreate({ name: "Engineering" }));

    expect(out).toBe("engineering\tEngineering\n");
    expect(out).not.toContain("cat_abc123");
  });

  test("slug is pipeable as a document category value", async () => {
    mockFetch(() => Response.json({ category: CATEGORY }));

    const out = await captureStdout(() => commandCategoryCreate({ name: "Engineering" }));

    expect(out.split("\t")[0]).toBe("engineering");
  });
});

describe("commandCategoryLs", () => {
  test("outputs slug then name — not the internal id", async () => {
    mockFetch(() => Response.json({ categories: [CATEGORY] }));

    const out = await captureStdout(() => commandCategoryLs());

    expect(out).toBe("engineering\tEngineering\n");
    expect(out).not.toContain("cat_abc123");
  });
});

describe("commandCategoryEdit", () => {
  test("outputs slug then name after update", async () => {
    const updated = { ...CATEGORY, name: "Eng", slug: "eng" };
    mockFetch((url) =>
      url.endsWith("/categories")
        ? Response.json({ categories: [CATEGORY] })
        : Response.json({ category: updated }),
    );

    const out = await captureStdout(() =>
      commandCategoryEdit("engineering", { name: "Eng", slug: "eng" }),
    );

    expect(out).toBe("eng\tEng\n");
    expect(out).not.toContain("cat_abc123");
  });
});

describe("commandCategoryRm", () => {
  test("outputs deleted then slug — not the internal id", async () => {
    mockFetch((url) =>
      url.endsWith("/categories")
        ? Response.json({ categories: [CATEGORY] })
        : new Response(null, { status: 204 }),
    );

    const out = await captureStdout(() => commandCategoryRm("engineering"));

    expect(out).toBe("deleted\tengineering\n");
    expect(out).not.toContain("cat_abc123");
  });
});

// ---------------------------------------------------------------------------
// vektor write — markdown create path
// ---------------------------------------------------------------------------

describe("commandCreate (vektor write --slug <slug>)", () => {
  test("sends contentType:text/markdown so the server converts content to HTML before storing", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({ slug: "my-doc", source: makeTempFile("input.md", "# Hello\n") }),
    );

    expect(body.contentType).toBe("text/markdown");
    expect(body.type).toBeUndefined();
  });

  test("sends the slug in the request body", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({ slug: "my-doc", source: makeTempFile("input2.md", "# Hello\n") }),
    );

    expect(body.slug).toBe("my-doc");
  });

  test("sends raw markdown content to the server for conversion", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({ slug: "my-doc", source: makeTempFile("input3.md", "# Hello\n") }),
    );

    expect(body.content).toBe("# Hello\n");
  });

  test("outputs id and slug on success", async () => {
    mockFetch(() => Response.json({ document: { id: "doc-abc", slug: "my-doc" } }));

    const out = await captureStdout(() =>
      commandCreate({ slug: "my-doc", source: makeTempFile("input4.md", "# Hello\n") }),
    );

    expect(out).toBe("doc-abc\tmy-doc\n");
  });

  test("--title sets properties.title", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("t1.md", "# Hello\n"),
        properties: { title: "My Title" },
      }),
    );

    expect((body.properties as Record<string, string>).title).toBe("My Title");
  });

  test("--category sets properties.category", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("t2.md", "# Hello\n"),
        properties: { category: "engineering" },
      }),
    );

    expect((body.properties as Record<string, string>).category).toBe("engineering");
  });

  test("--modified sets updatedAt, not a property", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("t4.md", "# Hello\n"),
        modified: "2024-01-15T10:00:00.000Z",
      }),
    );

    expect(body.updatedAt).toBe("2024-01-15T10:00:00.000Z");
    expect(
      (body.properties as Record<string, string> | undefined)?.modified,
    ).toBeUndefined();
  });

  test("--created sets createdAt in the request body", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("c1.md", "# Hello\n"),
        created: "2023-06-01T00:00:00.000Z",
      }),
    );

    expect(body.createdAt).toBe("2023-06-01T00:00:00.000Z");
    expect(
      (body.properties as Record<string, string> | undefined)?.created,
    ).toBeUndefined();
  });

  test("--created overrides frontmatter created", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    const content = "---\ncreated: 2020-01-01T00:00:00.000Z\n---\n# Hello\n";
    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("c2.md", content),
        created: "2023-06-01T00:00:00.000Z",
      }),
    );

    expect(body.createdAt).toBe("2023-06-01T00:00:00.000Z");
  });

  test("--modified overrides frontmatter modified", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    const content = "---\nmodified: 2020-01-01T00:00:00.000Z\n---\n# Hello\n";
    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("t5.md", content),
        modified: "2024-06-01T00:00:00.000Z",
      }),
    );

    expect(body.updatedAt).toBe("2024-06-01T00:00:00.000Z");
  });

  test("CLI flags override frontmatter properties (write)", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ document: { id: "doc-1", slug: "my-doc" } });
    });

    const content = "---\ntitle: Frontmatter Title\ncategory: old-cat\n---\n# Hello\n";
    await captureStdout(() =>
      commandCreate({
        slug: "my-doc",
        source: makeTempFile("t3.md", content),
        properties: { title: "CLI Title", category: "new-cat" },
      }),
    );

    const props = body.properties as Record<string, string>;
    expect(props.title).toBe("CLI Title");
    expect(props.category).toBe("new-cat");
  });
});

// ---------------------------------------------------------------------------
// vektor set — property and metadata patches
// ---------------------------------------------------------------------------

describe("commandSet", () => {
  const DOC_ID = "doc-set-test";

  test("key=value assignment sends properties patch", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ success: true });
    });

    const out = await captureStdout(() => commandSet(DOC_ID, ["status=published"], {}));

    expect(body.properties).toEqual({ status: "published" });
    expect(out).toBe(`updated\t${DOC_ID}\n`);
  });

  test("-key assignment deletes the property (null value)", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ success: true });
    });

    await captureStdout(() => commandSet(DOC_ID, ["-status"], {}));

    expect((body.properties as Record<string, null>).status).toBeNull();
  });

  test("--title sets properties.title", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ success: true });
    });

    await captureStdout(() => commandSet(DOC_ID, [], { title: "My New Title" }));

    expect((body.properties as Record<string, string>).title).toBe("My New Title");
  });

  test("--category sets properties.category", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ success: true });
    });

    await captureStdout(() => commandSet(DOC_ID, [], { category: "engineering" }));

    expect((body.properties as Record<string, string>).category).toBe("engineering");
  });

  test("--title and --category can be combined with positional assignments", async () => {
    const bodies: Record<string, unknown>[] = [];
    mockFetch((_url, init) => {
      bodies.push(JSON.parse(init?.body as string));
      return Response.json({ success: true });
    });

    await captureStdout(() =>
      commandSet(DOC_ID, ["status=draft"], { title: "Hello", category: "news" }),
    );

    expect(bodies).toHaveLength(1);
    const props = bodies[0].properties as Record<string, string>;
    expect(props.title).toBe("Hello");
    expect(props.category).toBe("news");
    expect(props.status).toBe("draft");
  });

  test("--parent sends a parentId PATCH", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ success: true });
    });

    await captureStdout(() => commandSet(DOC_ID, [], { parent: "parent-doc-1" }));

    expect(body.parentId).toBe("parent-doc-1");
  });

  test("--parent - clears the parent (sends null)", async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_url, init) => {
      body = JSON.parse(init?.body as string);
      return Response.json({ success: true });
    });

    await captureStdout(() => commandSet(DOC_ID, [], { parent: "-" }));

    expect(body.parentId).toBeNull();
  });
});
