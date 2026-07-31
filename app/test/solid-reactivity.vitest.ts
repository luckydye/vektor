import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards Solid components against the destructuring that silently kills
 * reactivity.
 *
 * In Solid, `props` is a proxy whose getters *are* the subscription. Reading a
 * value out of it — by destructuring, or into a local — takes the value once
 * and unsubscribes forever. The component still renders, still type-checks, and
 * simply stops updating. It is the dominant Solid migration bug, and with a
 * single-cutover branch these accumulate unobserved, so they are worth catching
 * at the source level.
 *
 * A source scan rather than ESLint, following the precedent
 * `server-frontend-imports.spec.ts` sets: same runner, same `task test`, no
 * second toolchain. Biome has no Solid rules.
 *
 * **Honest limits.** This sees prop destructuring and read-once locals. It
 * cannot see a signal read stored in a plain local inside a nested closure, or
 * a prop crossing a non-tracking boundary. Tier 1's interaction specs are the
 * backstop for those.
 */

// `process.cwd()`, not `import.meta.dirname` (Bun-only) and not `import.meta.url`
// (vitest transforms modules, so it is not a `file:` URL inside a test).
// Vitest runs with its config root as the working directory, which is `app/`.
const APP_ROOT = resolve(process.cwd());
const SOURCE_DIR = join(APP_ROOT, "src");

/** Opt out on the offending line: `// solid-reactivity-ok: forwarded verbatim`. */
const ESCAPE_HATCH = /\/\/\s*solid-reactivity-ok:/;

/** These legitimately return props-like objects that may be destructured. */
const SAFE_HELPERS = /\b(?:splitProps|mergeProps)\s*\(/;

export interface Violation {
  file: string;
  line: number;
  rule: string;
  source: string;
}

function collectTsxFiles(dir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectTsxFiles(full));
    else if (full.endsWith(".tsx")) found.push(full);
  }
  return found;
}

/** Strips comments so a commented-out example is not reported. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
}

const RULES: Array<{ name: string; pattern: RegExp }> = [
  {
    // const { a, b } = props   /   let { a } = props
    name: "destructured props object",
    pattern: /\b(?:const|let|var)\s*\{[^}]*\}\s*=\s*(?:props|_props)\b/,
  },
  {
    // const [local, rest] = props — array destructuring is just as lossy
    name: "destructured props array",
    pattern: /\b(?:const|let|var)\s*\[[^\]]*\]\s*=\s*(?:props|_props)\b/,
  },
  {
    // function Name({ a, b })   /   ({ a }: Props) =>
    name: "destructured component parameter",
    pattern:
      /(?:function\s+[A-Z]\w*\s*\(\s*\{|\(\s*\{[^}]*\}\s*:\s*[A-Z]\w*(?:Props)?\s*\)\s*=>)/,
  },
  {
    // const value = props.thing — reads once, never updates again
    name: "read-once local from props",
    pattern: /\b(?:const|let|var)\s+\w+\s*=\s*props\.\w+\s*;?\s*$/,
  },
];

export function findViolations(source: string, file: string): Violation[] {
  const violations: Violation[] = [];
  const lines = stripBlockComments(source).split("\n");

  for (const [index, line] of lines.entries()) {
    const code = line.replace(/\/\/.*$/, (comment) =>
      ESCAPE_HATCH.test(comment) ? comment : "",
    );
    if (ESCAPE_HATCH.test(line)) continue;
    if (SAFE_HELPERS.test(code)) continue;

    for (const rule of RULES) {
      if (rule.pattern.test(code)) {
        violations.push({ file, line: index + 1, rule: rule.name, source: line.trim() });
        break;
      }
    }
  }

  return violations;
}

describe("solid reactivity", () => {
  it("no .tsx component destructures its props", () => {
    const files = collectTsxFiles(SOURCE_DIR);
    const violations = files.flatMap((file) =>
      findViolations(readFileSync(file, "utf8"), relative(APP_ROOT, file)),
    );

    expect(
      violations,
      violations.length === 0
        ? ""
        : "Destructuring `props` unsubscribes from it — the component renders once " +
            "and then stops updating.\n\n" +
            "Use `props.thing` at the point of use, or `splitProps`/`mergeProps` when " +
            "a group has to be passed on. If a case is genuinely safe, mark the line " +
            "`// solid-reactivity-ok: <reason>` so it shows up in review.\n\n" +
            violations
              .map((v) => `  ${v.file}:${v.line}  [${v.rule}]\n    ${v.source}`)
              .join("\n\n"),
    ).toEqual([]);
  });

  it("passes trivially while the tree is still Vue", () => {
    // Phase 1 has no `.tsx` components yet, so the scan above proves nothing on
    // its own. The detector cases below are what keep it honest until it does.
    expect(collectTsxFiles(SOURCE_DIR)).toEqual([]);
  });
});

/**
 * The scan has nothing to scan until phase 3, so the detector is exercised
 * directly. Without this, the guard could match nothing at all and still look
 * green for months — which is exactly how a lint quietly stops working.
 */
describe("solid reactivity detector", () => {
  const BAD: Array<[label: string, code: string]> = [
    ["object destructuring", "const { title, count } = props;"],
    ["let destructuring", "let { title } = props;"],
    ["array destructuring", "const [first] = props;"],
    ["renamed props parameter", "const { title } = _props;"],
    ["destructured function parameter", "function Card({ title }) { return title; }"],
    ["destructured arrow parameter", "const Card = ({ title }: CardProps) => title;"],
    ["read-once local", "const title = props.title;"],
  ];

  for (const [label, code] of BAD) {
    it(`flags ${label}`, () => {
      const found = findViolations(code, "sample.tsx");
      expect(found.length, `expected a violation for: ${code}`).toBeGreaterThan(0);
    });
  }

  const GOOD: Array<[label: string, code: string]> = [
    ["reading through props at the point of use", "return <p>{props.title}</p>;"],
    ["splitProps", "const [local, rest] = splitProps(props, ['title']);"],
    ["mergeProps", "const merged = mergeProps({ size: 'md' }, props);"],
    ["destructuring something that is not props", "const { rows } = table;"],
    ["a plain untyped parameter", "function Card(props) { return props.title; }"],
    ["a computed from props", "const title = () => props.title;"],
    [
      "the escape hatch",
      "const { title } = props; // solid-reactivity-ok: static, set once",
    ],
    ["a commented-out example", "// const { title } = props;"],
  ];

  for (const [label, code] of GOOD) {
    it(`allows ${label}`, () => {
      const found = findViolations(code, "sample.tsx");
      expect(found, `unexpected violation for: ${code}`).toEqual([]);
    });
  }

  it("reports the file, line and rule so the failure is actionable", () => {
    const source = ["const ok = 1;", "const { title } = props;"].join("\n");
    const [violation] = findViolations(source, "src/components/Card.tsx");
    expect(violation).toMatchObject({ file: "src/components/Card.tsx", line: 2 });
    expect(violation?.rule).toContain("destructured");
  });
});
