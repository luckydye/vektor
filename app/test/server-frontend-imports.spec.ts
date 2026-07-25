import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Guards the server's document path against frontend libraries.
 *
 * The server builds `contentExtensions` to derive a ProseMirror schema and to
 * (de)serialize documents — on the main thread and inside every serialization
 * pool worker. Editor extensions are shared with the client, so it is very easy
 * for one to statically import a browser-only rendering library (a lit node
 * view, a Vue composable) and drag the whole framework into the server process
 * for no benefit. That happened with lit-html (via `HtmlBlock`) and with the
 * Vue runtime *and compiler* (via `useUploads`, the extension manager, the
 * editor keymap's `useEditor` refs, and `lang.ts`'s injected locale).
 *
 * Client behaviour belongs in a separate module that the client injects — see
 * `HtmlBlockNodeView.ts` and `editSession.ts` — or behind a
 * dynamic `import()` inside a browser-only code path. Both keep the module out
 * of the server's *static* graph, which is what this test walks.
 *
 * Scope is deliberately the document/serialization path, not the whole server:
 * Astro server-renders Vue components, so `server.ts` legitimately loads Vue.
 */

const APP_ROOT = resolve(import.meta.dir, "..");

/** Package names that must never be statically reachable from the roots below. */
const FRONTEND_PACKAGES = [
  "vue",
  "@vue",
  "lit",
  "lit-html",
  "lit-element",
  "@lit",
  "@lit-labs",
];

/** Server-side entry points into document handling. */
const SERVER_ROOTS = [
  "src/editor/extensions.ts",
  "src/serialization/core.ts",
  "src/serialization/worker.ts",
  "src/serialization/pool.ts",
  "src/realtime/yjsRooms.ts",
];

const aliases: Record<string, string> = JSON.parse(
  readFileSync(join(APP_ROOT, "package.json"), "utf8"),
).imports;

/** Strips comments so commented-out imports are not treated as real edges. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Static import/re-export specifiers only. `import type` / `export type` are
 * erased at compile time, and `import(...)` is deferred until the code runs, so
 * neither loads anything on the server.
 */
function staticImports(source: string): string[] {
  const code = stripComments(source);
  const specifiers: string[] = [];

  // import ... from "x" / export ... from "x", excluding the `type` forms.
  const fromRe =
    /(^|[\s;}])(import|export)\s+(?!type\s)([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(fromRe)) {
    const clause = match[3] ?? "";
    // `import { type A, type B } from "x"` is also fully erased.
    const bindings = clause.match(/\{([\s\S]*)\}/)?.[1];
    if (bindings?.trim()) {
      const named = bindings
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const hasDefaultOrNamespace = /^[^{]*[A-Za-z_$*]/.test(clause.split("{")[0] ?? "");
      if (!hasDefaultOrNamespace && named.every((n) => n.startsWith("type "))) continue;
    }
    specifiers.push(match[4] as string);
  }

  // Side-effect imports: import "x"
  for (const match of code.matchAll(/(^|[\s;}])import\s+["']([^"']+)["']/g)) {
    specifiers.push(match[2] as string);
  }

  return specifiers;
}

/** Resolves an app-internal specifier to a file path, or null if external. */
function resolveInternal(specifier: string, fromFile: string): string | null {
  let target: string | null = null;

  if (specifier.startsWith("#")) {
    for (const [pattern, replacement] of Object.entries(aliases)) {
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -1);
        if (specifier.startsWith(prefix)) {
          target = join(
            APP_ROOT,
            replacement.slice(0, -1) + specifier.slice(prefix.length),
          );
          break;
        }
      } else if (specifier === pattern) {
        target = join(APP_ROOT, replacement);
        break;
      }
    }
  } else if (specifier.startsWith("~/")) {
    target = join(APP_ROOT, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    target = resolve(dirname(fromFile), specifier);
  }

  if (!target) return null;
  // Assets cannot import anything; don't try to read them.
  if (/\.(css|json|svg|png|jpe?g|webp|woff2?|txt|md)(\?.*)?$/.test(target)) return null;
  return target.replace(/\?.*$/, "");
}

function readModule(path: string): string | null {
  const candidates = [
    path,
    path.replace(/\.js$/, ".ts"),
    `${path}.ts`,
    join(path, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function forbiddenPackage(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("#") ||
    specifier.startsWith("~")
  ) {
    return null;
  }
  return (
    FRONTEND_PACKAGES.find(
      (pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`),
    ) ?? null
  );
}

/** Walks the static graph from `root`, returning `file -> importer` chains to violations. */
function findViolations(root: string): string[] {
  const rootPath = join(APP_ROOT, root);
  const parents = new Map<string, string>();
  const seen = new Set<string>([rootPath]);
  const queue = [rootPath];
  const violations: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const source = readModule(current);
    if (!source) continue;

    for (const specifier of staticImports(source)) {
      const pkg = forbiddenPackage(specifier);
      if (pkg) {
        const chain: string[] = [];
        for (let node: string | undefined = current; node; node = parents.get(node)) {
          chain.unshift(relative(APP_ROOT, node));
        }
        violations.push(`${chain.join("\n    → ")}\n    → imports "${specifier}"`);
        continue;
      }

      const next = resolveInternal(specifier, current);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      parents.set(next, current);
      queue.push(next);
    }
  }

  return violations;
}

describe("server document path", () => {
  for (const root of SERVER_ROOTS) {
    it(`does not statically import a frontend library from ${root}`, () => {
      const violations = findViolations(root);
      expect(
        violations,
        violations.length === 0
          ? ""
          : `${root} statically reaches a frontend library.\n\n` +
              `Move the browser-only code into a separate client module (see ` +
              `HtmlBlockNodeView.ts / editSession.ts) or load it with a ` +
              `dynamic import() inside the browser-only path.\n\n${violations.join("\n\n")}`,
      ).toEqual([]);
    });
  }

  it("detects a frontend import when one is introduced", () => {
    // Guards the walker itself: a root that legitimately imports Vue must be
    // reported, otherwise the assertions above could pass vacuously.
    expect(findViolations("src/utils/lang.ts").length).toBeGreaterThan(0);
  });
});
