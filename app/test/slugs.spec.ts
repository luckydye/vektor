/**
 * The slug rules, tested without a server.
 *
 * `slugs-api.spec.ts` covers the endpoints that apply them; this file pins the
 * rules themselves, including the one guard that cannot live in the source: that
 * a new top-level route in `src/pages/` or a new file in `public/` has been added
 * to `reservedSpaceSlugs`, so it cannot silently start shadowing a space.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  availableSpaceSlug,
  isReservedSpaceSlug,
  reservedSpaceSlugs,
  slugify,
  spaceSlugRejection,
} from "#utils/utils.ts";

// The runner's cwd is `app/`, see test/helpers/server.ts.
const PAGES_DIR = path.resolve("src/pages");
const PUBLIC_DIR = path.resolve("public");

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

describe("availableSpaceSlug", () => {
  it("keeps a free slug", () => {
    expect(availableSpaceSlug("engineering", () => false)).toBe("engineering");
  });

  it("steps past a reserved slug", () => {
    expect(availableSpaceSlug("docs", () => false)).toBe("docs-1");
  });

  it("steps past a taken slug", () => {
    const taken = new Set(["docs-1", "docs-2"]);
    expect(availableSpaceSlug("docs", (slug) => taken.has(slug))).toBe("docs-3");
  });

  it("falls back for a slug with nothing sluggable in it", () => {
    expect(availableSpaceSlug("日本語", () => false)).toBe("space");
  });
});
