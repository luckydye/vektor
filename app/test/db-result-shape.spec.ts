import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps driver result shapes behind `one`/`many`/`exec`.
 *
 * `.get()`, `.all()` and `.run()` are SQLite dialect methods on the drizzle
 * builder — the Postgres builders do not have them, and `.get()` in particular
 * fails quietly across dialects: it hands back a row where a Postgres driver
 * hands back an array, and the types usually still line up. Awaiting the
 * builder is the form every dialect shares, so the shape conversion lives in
 * `#db/client/query.ts` and nowhere else.
 *
 * The guard is textual on purpose. It is the cheap half of the invariant; the
 * expensive half is that a new call site reads like its neighbours.
 */

const APP_ROOT = resolve(import.meta.dirname, "..");

/** Server code that talks to a database. */
const DB_ROOTS = [
  "src/db",
  "src/acl",
  "src/jobs",
  "src/api",
  "src/notifications",
  "src/observability",
];

/** The file allowed to name the dialect methods, being the wrapper over them. */
const CHOKE_POINT = "src/db/client/query.ts";

const FORBIDDEN = [
  { pattern: /\.get\(\)/g, use: "one()" },
  { pattern: /\.all\(\)/g, use: "many()" },
  { pattern: /\.run\(/g, use: "exec()" },
  // The raw forms take an argument, so they are matched by the `sql` that can
  // only be a statement — a bare `.get(` is `Map.prototype.get` more often.
  { pattern: /\.(get|all)\(\s*sql/g, use: "many(db, statement)" },
];

function typescriptFilesIn(directory: string): string[] {
  const absolute = join(APP_ROOT, directory);
  const found: string[] = [];

  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) {
      found.push(...typescriptFilesIn(join(directory, entry)));
    } else if (entry.endsWith(".ts")) {
      found.push(relative(APP_ROOT, path));
    }
  }

  return found;
}

describe("database result shapes", () => {
  const files = DB_ROOTS.flatMap(typescriptFilesIn).filter(
    (file) => file !== CHOKE_POINT,
  );

  it("covers the server's database code", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(FORBIDDEN)("routes $use instead of $pattern", ({ pattern, use }) => {
    const offenders = files.filter((file) => {
      const source = readFileSync(join(APP_ROOT, file), "utf8");
      // Reset: a /g regex reused across files carries `lastIndex`.
      pattern.lastIndex = 0;
      return pattern.test(source);
    });

    expect(offenders, `use ${use} from #db/client/query.ts`).toStrictEqual([]);
  });
});
