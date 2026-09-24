/**
 * Shared Prism access for the app.
 *
 * Prism is loaded lazily for two reasons: the core bundle plus grammars is
 * sizeable, and Prism auto-highlights every `code[class*="language-"]` in the
 * page the moment its module body runs — which would rewrite markup the app
 * and ProseMirror own. The `manual` flag is read while that module body executes,
 * so the import has to stay dynamic to guarantee the flag is set first.
 *
 * Grammars beyond Prism's core bundle (markup, css, clike, javascript) are
 * imported on demand. The loader map is written out explicitly so the bundler
 * can see every chunk; `require` order from Prism's own components.json is
 * encoded as awaits on the dependency's loader.
 */

import { escapeHtml } from "#utils/html.ts";

type PrismModule = typeof import("prismjs");
type Grammar = PrismModule["languages"][string];
type PrismToken = {
  type: string;
  content: string | PrismToken | Array<string | PrismToken>;
  alias?: string | string[];
};

let prismPromise: Promise<PrismModule> | null = null;
let prism: PrismModule | null = null;

function loadPrism(): Promise<PrismModule> {
  if (!prismPromise) {
    prismPromise = (async () => {
      const globalScope = window as typeof window & { Prism?: { manual?: boolean } };
      globalScope.Prism = { ...globalScope.Prism, manual: true };
      const module = await import("prismjs");
      prism = module.default ?? (globalScope.Prism as unknown as PrismModule);
      return prism;
    })();
  }
  return prismPromise;
}

/** Language names as written in a fence or `language-*` class → Prism name. */
const LANGUAGE_ALIASES: Record<string, string> = {
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dotnet: "csharp",
  dockerfile: "docker",
  golang: "go",
  htm: "markup",
  html: "markup",
  js: "javascript",
  jsonc: "json",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  cjs: "javascript",
  objectivec: "c",
  plaintext: "",
  plain: "",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  "sh-session": "shell-session",
  shellsession: "shell-session",
  svg: "markup",
  text: "",
  txt: "",
  ts: "typescript",
  vue: "markup",
  webmanifest: "json",
  xml: "markup",
  yml: "yaml",
  zsh: "bash",
};

/**
 * Grammars that ship in Prism's core bundle. They need no component import,
 * only `loadPrism()`.
 */
const CORE_LANGUAGES = new Set(["clike", "css", "javascript", "markup"]);

const LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  bash: () => import("prismjs/components/prism-bash.js"),
  c: () => loadWith("clike", () => import("prismjs/components/prism-c.js")),
  cpp: () => loadWith("c", () => import("prismjs/components/prism-cpp.js")),
  csharp: () => loadWith("clike", () => import("prismjs/components/prism-csharp.js")),
  diff: () => import("prismjs/components/prism-diff.js"),
  docker: () => import("prismjs/components/prism-docker.js"),
  git: () => import("prismjs/components/prism-git.js"),
  go: () => loadWith("clike", () => import("prismjs/components/prism-go.js")),
  graphql: () => import("prismjs/components/prism-graphql.js"),
  hcl: () => import("prismjs/components/prism-hcl.js"),
  ini: () => import("prismjs/components/prism-ini.js"),
  java: () => loadWith("clike", () => import("prismjs/components/prism-java.js")),
  json: () => import("prismjs/components/prism-json.js"),
  json5: () => loadWith("json", () => import("prismjs/components/prism-json5.js")),
  jsx: () => loadWith("javascript", () => import("prismjs/components/prism-jsx.js")),
  kotlin: () => loadWith("clike", () => import("prismjs/components/prism-kotlin.js")),
  less: () => loadWith("css", () => import("prismjs/components/prism-less.js")),
  lua: () => import("prismjs/components/prism-lua.js"),
  markdown: () =>
    loadWith("markup", () => import("prismjs/components/prism-markdown.js")),
  nginx: () => import("prismjs/components/prism-nginx.js"),
  php: () =>
    loadWith("markup-templating", () => import("prismjs/components/prism-php.js")),
  "markup-templating": () => import("prismjs/components/prism-markup-templating.js"),
  powershell: () => import("prismjs/components/prism-powershell.js"),
  protobuf: () => loadWith("clike", () => import("prismjs/components/prism-protobuf.js")),
  python: () => import("prismjs/components/prism-python.js"),
  r: () => import("prismjs/components/prism-r.js"),
  regex: () => import("prismjs/components/prism-regex.js"),
  ruby: () => loadWith("clike", () => import("prismjs/components/prism-ruby.js")),
  rust: () => import("prismjs/components/prism-rust.js"),
  scala: () => loadWith("java", () => import("prismjs/components/prism-scala.js")),
  scss: () => loadWith("css", () => import("prismjs/components/prism-scss.js")),
  "shell-session": () =>
    loadWith("bash", () => import("prismjs/components/prism-shell-session.js")),
  sql: () => import("prismjs/components/prism-sql.js"),
  swift: () => import("prismjs/components/prism-swift.js"),
  toml: () => import("prismjs/components/prism-toml.js"),
  tsx: async () => {
    await ensureLanguage("jsx");
    return loadWith("typescript", () => import("prismjs/components/prism-tsx.js"));
  },
  typescript: () =>
    loadWith("javascript", () => import("prismjs/components/prism-typescript.js")),
  yaml: () => import("prismjs/components/prism-yaml.js"),
};

async function loadWith(dependency: string, load: () => Promise<unknown>) {
  await ensureLanguage(dependency);
  return load();
}

/**
 * Resolve a fence/class language to a Prism grammar name. Returns `null` for
 * empty, unknown, or explicitly plain-text languages — those stay unhighlighted.
 */
export function normalizeLanguage(language: unknown): string | null {
  if (typeof language !== "string") return null;
  const name = language.trim().toLowerCase();
  if (!name) return null;
  const resolved = name in LANGUAGE_ALIASES ? LANGUAGE_ALIASES[name] : name;
  if (!resolved) return null;
  if (CORE_LANGUAGES.has(resolved) || resolved in LANGUAGE_LOADERS) return resolved;
  return null;
}

const languagePromises = new Map<string, Promise<Grammar | null>>();

/**
 * Load Prism and the grammar for `language`, resolving to the grammar or
 * `null` when the language is unsupported or its component fails to load.
 */
export function ensureLanguage(language: string): Promise<Grammar | null> {
  const cached = languagePromises.get(language);
  if (cached) return cached;

  const pending = (async () => {
    const instance = await loadPrism();
    if (instance.languages[language]) return instance.languages[language];

    const load = LANGUAGE_LOADERS[language];
    if (!load) return null;

    try {
      await load();
    } catch (error) {
      // A missing grammar degrades to plain text; it shouldn't break the doc.
      console.error(`Failed to load Prism grammar "${language}"`, error);
      return null;
    }
    return instance.languages[language] ?? null;
  })();

  languagePromises.set(language, pending);
  return pending;
}

/** The grammar for `language` if it is already loaded. Never triggers a load. */
export function grammarFor(language: string): Grammar | null {
  return prism?.languages[language] ?? null;
}

/**
 * Highlight `code` to token-span HTML. Falls back to escaped plain text when the
 * grammar isn't loaded yet, so a caller can render synchronously and re-render
 * once `ensureLanguage` resolves.
 *
 * For DOM that ProseMirror owns, use tokenRanges/decorations instead.
 */
export function highlightToHtml(code: string, language: string): string {
  const instance = prism;
  const grammar = grammarFor(language);
  if (!instance || !grammar) return escapeHtml(code);

  try {
    return instance.highlight(code, grammar, language);
  } catch (error) {
    console.error(`Prism failed to highlight "${language}"`, error);
    return escapeHtml(code);
  }
}

export type CodeTokenRange = {
  /** Offset into the tokenized source, in code points as JS counts them. */
  from: number;
  to: number;
  /** Ready-to-use class attribute, e.g. `token keyword`. */
  className: string;
};

/**
 * Tokenize `code` into flat, possibly nested ranges. Nested tokens produce
 * overlapping ranges, mirroring the nested `<span>`s Prism's own output would
 * have — the innermost class wins by stylesheet order.
 */
export function tokenRanges(
  code: string,
  grammar: Grammar,
  language: string,
): CodeTokenRange[] {
  const instance = prism;
  if (!instance) return [];

  const ranges: CodeTokenRange[] = [];
  let stream: Array<string | PrismToken>;
  try {
    stream = instance.tokenize(code, grammar) as Array<string | PrismToken>;
  } catch (error) {
    console.error(`Prism failed to tokenize "${language}"`, error);
    return [];
  }

  collectRanges(stream, 0, ranges);
  return ranges;
}

function collectRanges(
  stream: Array<string | PrismToken>,
  start: number,
  ranges: CodeTokenRange[],
): number {
  let offset = start;
  for (const item of stream) {
    if (typeof item === "string") {
      offset += item.length;
      continue;
    }

    const classes = ["token", item.type];
    if (typeof item.alias === "string") classes.push(item.alias);
    else if (Array.isArray(item.alias)) classes.push(...item.alias);

    const length = contentLength(item.content);
    ranges.push({ from: offset, to: offset + length, className: classes.join(" ") });

    if (typeof item.content === "string") {
      offset += item.content.length;
    } else {
      const children = Array.isArray(item.content) ? item.content : [item.content];
      offset = collectRanges(children, offset, ranges);
    }
  }
  return offset;
}

/**
 * Length of a token's content in source characters. Prism sets a `length` on
 * tokens, but only for the top level of a `tokenize` pass, so it is recomputed
 * here rather than trusted.
 */
function contentLength(
  content: string | PrismToken | Array<string | PrismToken>,
): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let total = 0;
    for (const item of content) total += contentLength(item);
    return total;
  }
  return contentLength(content.content);
}

/**
 * Highlight static, already-rendered code blocks under `root` (read mode).
 *
 * The `<code>` markup is replaced with Prism's token spans, so only call this
 * on trees nobody else owns — never on a live ProseMirror surface, which uses
 * decorations instead.
 */
export async function highlightStaticCodeBlocks(root: ParentNode): Promise<void> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'),
  );
  if (blocks.length === 0) return;

  const languages = new Map<HTMLElement, string>();
  for (const block of blocks) {
    const raw = Array.from(block.classList)
      .find((name) => name.startsWith("language-"))
      ?.slice("language-".length);
    const language = normalizeLanguage(raw);
    if (language) languages.set(block, language);
  }
  if (languages.size === 0) return;

  await Promise.all([...new Set(languages.values())].map(ensureLanguage));

  for (const [block, language] of languages) {
    // The document may have re-rendered while grammars were loading.
    if (!block.isConnected) continue;
    if (!grammarFor(language)) continue;
    block.innerHTML = highlightToHtml(block.textContent ?? "", language);
  }
}
