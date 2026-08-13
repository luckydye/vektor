/**
 * The slug rules, tested without a server.
 *
 * `slugs-api.spec.ts` covers the endpoints that apply them; this file pins the
 * rules themselves, including the one guard that cannot live in the source: that
 * a new top-level route in `src/pages/` or a new file in `public/` has been added
 * to `reservedSpaceSlugs`, so it cannot silently start shadowing a space.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fallbackDocumentSlug, isPlaceholderDocumentSlug } from "#documents/types.ts";
import {
  isReservedSpaceSlug,
  reservedSpaceSlugs,
  slugify,
  spaceSlugRejection,
} from "#utils/utils.ts";

// The runner's cwd is `app/`, see test/helpers/server.ts.
const PAGES_DIR = path.resolve("src/pages");
const PUBLIC_DIR = path.resolve("public");
const SERVER_FILE = path.resolve("src/server.ts");

describe("slugify", () => {
  it("folds diacritics instead of dropping them", () => {
    expect(slugify("Café")).toBe("cafe");
    expect(slugify("Über uns")).toBe("uber-uns");
    expect(slugify("Ärger")).toBe("arger");
    expect(slugify("Æther")).toBe("aether");
  });

  it("folds the Latin letters NFKD leaves alone", () => {
    expect(slugify("Straße")).toBe("strasse");
    expect(slugify("Œuvre")).toBe("oeuvre");
    expect(slugify("Smørrebrød")).toBe("smorrebrod");
    expect(slugify("Þingvellir")).toBe("thingvellir");
    expect(slugify("Łódź")).toBe("lodz");
  });

  it("keeps ordinary titles as they were", () => {
    expect(slugify("Getting Started")).toBe("getting-started");
    expect(slugify("  Trim -- me  ")).toBe("trim-me");
    expect(slugify("Q3/2026 Report")).toBe("q3-2026-report");
  });

  it("returns an empty slug for scripts with no ASCII fold", () => {
    // Empty is a legitimate answer, not an error: the caller substitutes a
    // generated slug rather than refusing the write.
    for (const title of [
      "日本語のドキュメント",
      "Привет мир",
      "مرحبا",
      "한국어",
      "Ελλάδα",
    ]) {
      expect(slugify(title)).toBe("");
    }
    expect(slugify("-----")).toBe("");
    expect(slugify("💥🎉")).toBe("");
  });

  it("no longer suffixes reserved names itself", () => {
    // Reserved names are the caller's business — a document slug and a space
    // slug compete with different routes.
    expect(slugify("new")).toBe("new");
    expect(slugify("Docs")).toBe("docs");
  });
});

describe("reservedSpaceSlugs", () => {
  it("covers the slugs the audit found shadowed", () => {
    for (const slug of ["api", "docs", "login", "new", "404", "_astro", ".well-known"]) {
      expect(isReservedSpaceSlug(slug)).toBe(true);
    }
    expect(isReservedSpaceSlug("favicon.ico")).toBe(true);
    expect(isReservedSpaceSlug("robots.txt")).toBe(true);
  });

  it("matches regardless of case", () => {
    expect(isReservedSpaceSlug("Docs")).toBe(true);
    expect(isReservedSpaceSlug("LOGIN")).toBe(true);
  });

  it("leaves ordinary slugs alone", () => {
    expect(isReservedSpaceSlug("engineering")).toBe(false);
    expect(isReservedSpaceSlug("docs-team")).toBe(false);
  });

  /**
   * The list cannot be derived at runtime — a compiled binary has no
   * `src/pages/` — so this is what keeps it honest. A new top-level page or
   * public asset fails here until it is reserved.
   */
  it("covers every top-level route in src/pages", () => {
    const routes = readdirSync(PAGES_DIR, { withFileTypes: true })
      .map((entry) =>
        entry.isDirectory() ? entry.name : entry.name.replace(/\.(astro|ts|md)$/, ""),
      )
      // `index` is the root route and `[…]` is the space catch-all itself.
      .filter((name) => name !== "index" && !name.startsWith("["));

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(isReservedSpaceSlug(route), `src/pages/${route} is not reserved`).toBe(true);
    }
  });

  /**
   * `src/pages/` is only half of it: Hono answers its own routes before the
   * Astro fallback, which runs on a 404 only, so a space on `metrics` serves
   * Prometheus output at its root and no page file records that.
   */
  it("covers every top-level route src/server.ts registers", () => {
    const routes = [
      ...readFileSync(SERVER_FILE, "utf8").matchAll(
        /\bapp\.(?:get|post|put|patch|delete|all|use)\(\s*"\/([^/"*:]+)/g,
      ),
    ].map(([, segment]) => segment);

    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(isReservedSpaceSlug(route), `src/server.ts owns /${route}`).toBe(true);
    }
  });

  it("covers every asset in public", () => {
    for (const entry of readdirSync(PUBLIC_DIR)) {
      expect(isReservedSpaceSlug(entry), `public/${entry} is not reserved`).toBe(true);
    }
  });

  it("lists nothing twice", () => {
    expect(new Set(reservedSpaceSlugs).size).toBe(reservedSpaceSlugs.length);
  });
});

describe("spaceSlugRejection", () => {
  it("accepts a canonical slug", () => {
    expect(spaceSlugRejection("engineering")).toBeUndefined();
    expect(spaceSlugRejection("q3-2026")).toBeUndefined();
    expect(spaceSlugRejection("  spaced-out  ")).toBeUndefined();
  });

  it("rejects a slug the URL cannot carry", () => {
    expect(spaceSlugRejection("has spaces")).toMatch(/lowercase letters/);
    expect(spaceSlugRejection("a/b/c")).toMatch(/lowercase letters/);
    expect(spaceSlugRejection("UPPER💥")).toMatch(/lowercase letters/);
    expect(spaceSlugRejection("café")).toMatch(/lowercase letters/);
  });

  it("names the slug it would have stored", () => {
    // The rule alone does not explain these: both hold nothing but lowercase
    // letters and hyphens, which is exactly what the form's own hint asks for.
    expect(spaceSlugRejection("my-team-")).toMatch(/try "my-team"/);
    expect(spaceSlugRejection("my--team")).toMatch(/try "my-team"/);
    expect(spaceSlugRejection("Café Wien")).toMatch(/try "cafe-wien"/);
  });

  it("rejects a slug with nothing sluggable in it", () => {
    expect(spaceSlugRejection("日本語")).toMatch(/at least one/);
    expect(spaceSlugRejection("-----")).toMatch(/at least one/);
    expect(spaceSlugRejection("")).toMatch(/at least one/);
  });

  it("rejects a reserved slug by name", () => {
    // Named in the message: the point is that the user learns why, instead of
    // ending up in a space silently called "docs-1".
    expect(spaceSlugRejection("docs")).toMatch(/"docs" is reserved/);
    expect(spaceSlugRejection("login")).toMatch(/reserved/);
    expect(spaceSlugRejection("api")).toMatch(/reserved/);
  });

  it("canonicalizes case rather than rejecting it", () => {
    expect(spaceSlugRejection("Engineering")).toBeUndefined();
  });
});

describe("isPlaceholderDocumentSlug", () => {
  it("counts a generated fallback slug, so a real title can replace it", () => {
    expect(isPlaceholderDocumentSlug(fallbackDocumentSlug("doc_ffff1a2b3c4d"))).toBe(
      true,
    );
    // A UUID tail is hex, so it can be all digits, and it can carry the
    // generator's own uniquifier.
    expect(isPlaceholderDocumentSlug("document-12345678")).toBe(true);
    expect(isPlaceholderDocumentSlug("document-1a2b3c4d-2")).toBe(true);
  });

  it("still counts the placeholder titles", () => {
    expect(isPlaceholderDocumentSlug("untitled-document")).toBe(true);
    expect(isPlaceholderDocumentSlug("untitled-canvas-3")).toBe(true);
  });

  it("leaves a slug somebody's title produced alone", () => {
    expect(isPlaceholderDocumentSlug("meeting-notes")).toBe(false);
    expect(isPlaceholderDocumentSlug("document-notes")).toBe(false);
    expect(isPlaceholderDocumentSlug("documents")).toBe(false);
  });
});
