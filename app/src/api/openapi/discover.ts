import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRouteDoc } from "./comments.ts";
import type { RouteDoc } from "./types.ts";

const ROUTES_FILE = join(import.meta.dir, "../routes.ts");

const IMPORT_PATTERN = /import \* as (\w+) from "(\.\/routes\/[^"]+)";/g;
const ENTRY_PATTERN = /pattern:\s*"([^"]+)"[\s\S]*?module:\s*(\w+)/g;

/**
 * Map every registered route pattern to the source file that answers it, read
 * straight out of `routes.ts`'s own imports and its `apiRoutes` entries. Kept
 * separate from actually importing `routes.ts` — that module's own imports
 * pull in the whole server, which a doc build has no business doing.
 */
async function patternFilePaths(): Promise<Map<string, string>> {
  const source = await readFile(ROUTES_FILE, "utf8");

  const localNameToPath = new Map<string, string>();
  for (const [, localName, importPath] of source.matchAll(IMPORT_PATTERN)) {
    localNameToPath.set(localName, join(import.meta.dir, "..", importPath));
  }

  const patternToPath = new Map<string, string>();
  for (const [, pattern, localName] of source.matchAll(ENTRY_PATTERN)) {
    const path = localNameToPath.get(localName);
    if (path) patternToPath.set(pattern, path);
  }
  return patternToPath;
}

/**
 * Every `RouteDoc` this build can find, read live from each route file's own
 * handler comments. The dev server calls this on every process start (cheap:
 * ~75 small file reads), and the build script below calls it once to freeze
 * the result into the compiled binary.
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
