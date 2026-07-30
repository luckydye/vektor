import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The `#`-prefixed subpath map from `app/package.json`.
 *
 * Node and Bun resolve these natively; Vite does not, so anything running under
 * Vite (the Vitest frontend suite) has to be told about them. Both readers come
 * through here so the two never drift — a spec that passes under `bun test` and
 * fails to resolve under Vitest is a confusing way to find that out.
 */
export function subpathImports(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8"));
  return pkg.imports ?? {};
}

/**
 * `compilerOptions.paths` from `tsconfig.json` — currently just `~/*`.
 *
 * A second alias source, and an easy one to miss: Astro's Vite reads tsconfig
 * paths automatically, so `~/src/assets/icons.ts` resolves in the app and fails
 * under a bare Vitest config. Read rather than restated, for the same
 * anti-drift reason as `subpathImports`.
 */
export function tsconfigPaths(): Record<string, string> {
  const raw = readFileSync(join(APP_ROOT, "tsconfig.json"), "utf8");
  const paths = JSON.parse(raw).compilerOptions?.paths ?? {};
  return Object.fromEntries(
    Object.entries(paths).map(([pattern, targets]) => [
      pattern,
      (targets as string[])[0] as string,
    ]),
  );
}

export interface ViteAlias {
  find: string | RegExp;
  replacement: string;
}

/**
 * The same map as Vite `resolve.alias` entries.
 *
 * Wildcard subpaths (`#utils/*`) become a regex with a `$1` capture; exact ones
 * (`#config`) stay strings. Longest-first, because Vite takes the first match
 * and a bare `#config` must not be shadowed by a broader pattern.
 */
export function viteAliases(): ViteAlias[] {
  return Object.entries({ ...subpathImports(), ...tsconfigPaths() })
    .sort(([a], [b]) => b.length - a.length)
    .map(([specifier, target]) => {
      const absolute = resolve(APP_ROOT, target);
      if (!specifier.includes("*")) {
        return { find: specifier, replacement: absolute };
      }
      const prefix = specifier.slice(0, specifier.indexOf("*"));
      return {
        find: new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.*)$`),
        replacement: absolute.replace("*", "$1"),
      };
    });
}
