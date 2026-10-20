import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRouteDoc } from "./comments.ts";
import type { RouteDoc } from "./types.ts";

// `fileURLToPath(new URL(...))`, not Bun's `import.meta.dir`: this module is
// also imported through Vite (vitest), which does not define it.
const ROUTES_FILES = [
  fileURLToPath(new URL("../../../src/api/routes.ts", import.meta.url)),
  fileURLToPath(new URL("../../../src/api/gitRoutes.ts", import.meta.url)),
];

const IMPORT_PATTERN = /import \* as (\w+) from "(\.\/routes\/[^"]+)";/g;
const ENTRY_PATTERN = /pattern:\s*"([^"]+)"[\s\S]*?module:\s*(\w+)/g;

/**
 * Map every registered route pattern to the source file that answers it, read
 * straight out of each registry's own imports and route entries. Kept
 * separate from actually importing the registries — their imports pull in the
 * whole server, which a doc build has no business doing.
 */
async function patternFilePaths(): Promise<Map<string, string>> {
  const patternToPath = new Map<string, string>();
  for (const routesFile of ROUTES_FILES) {
    const source = await readFile(routesFile, "utf8");

    const localNameToPath = new Map<string, string>();
    for (const [, localName, importPath] of source.matchAll(IMPORT_PATTERN)) {
      localNameToPath.set(localName, join(dirname(routesFile), importPath));
    }

    for (const [, pattern, localName] of source.matchAll(ENTRY_PATTERN)) {
      const path = localNameToPath.get(localName);
      if (path) patternToPath.set(pattern, path);
    }
  }
  return patternToPath;
}

/**
 * Every `RouteDoc` this build can find, read live from each route file's own
 * handler comments. Called by `scripts/generate-openapi.ts`, which never runs
 * inside a compiled binary, so no doc-comment parsing lives in the runtime image.
 */
export async function loadRouteDocs(): Promise<Record<string, RouteDoc>> {
  const patternToPath = await patternFilePaths();
  const routeDocs: Record<string, RouteDoc> = {};

  for (const [pattern, path] of patternToPath) {
    const source = await readFile(path, "utf8");
    let doc: RouteDoc | undefined;
    try {
      doc = parseRouteDoc(source);
    } catch (error) {
      throw new Error(
        `Failed to parse OpenAPI doc comments in ${path} (${pattern}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (doc) routeDocs[pattern] = doc;
  }

  return routeDocs;
}
