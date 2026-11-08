import { Marked, type Tokens } from "marked";
import { createHighlighterCoreSync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "shiki/langs/bash.mjs";
import css from "shiki/langs/css.mjs";
import diff from "shiki/langs/diff.mjs";
import html from "shiki/langs/html.mjs";
import http from "shiki/langs/http.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import markdown from "shiki/langs/markdown.mjs";
import typescript from "shiki/langs/typescript.mjs";
import githubDark from "shiki/themes/github-dark.mjs";

export interface DocsHeading {
  depth: number;
  slug: string;
  text: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: DocsHeading[];
}

// Code samples are dark panels in both site themes, so one dark syntax theme is
// what the panel chrome in `styles/docs.css` is built around. Only the
// languages the docs use are bundled: the full set is several megabytes.
const THEME = "github-dark";
let highlighterInstance: ReturnType<typeof createHighlighterCoreSync> | undefined;

/** Built on first use: a server that never renders docs should not pay for the grammars. */
function getHighlighter() {
  highlighterInstance ??= createHighlighterCoreSync({
    themes: [githubDark],
    langs: [bash, css, diff, html, http, javascript, json, markdown, typescript],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterInstance;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  js: "javascript",
  ts: "typescript",
  md: "markdown",
};

function highlight(code: string, declared: string): string {
  const requested = LANGUAGE_ALIASES[declared] ?? declared;
  const highlighter = getHighlighter();
  const language = highlighter.getLoadedLanguages().includes(requested)
    ? requested
    : "text";
  return highlighter.codeToHtml(code, {
    lang: language,
    theme: THEME,
    // The page script labels each panel from this, so it names the language as
    // written rather than the grammar that happened to colour it.
    transformers: [
      {
        pre(node) {
          node.properties["data-language"] = declared || "text";
        },
      },
    ],
  });
}

/** GitHub's heading slugger: lowercase, punctuation dropped, spaces to hyphens, repeats numbered. */
function createSlugger() {
  const seen = new Map<string, number>();
  return (text: string): string => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

/** Plain text of a heading, without the markup its inline tokens carry. */
function headingText(token: Tokens.Heading): string {
  return token.tokens
    .map((child) => ("text" in child ? child.text : child.raw))
    .join("")
    .trim();
}

/**
 * Renders a docs page's markdown: highlighted code blocks, heading ids for
 * anchors, and the heading list the sidebar outline is built from.
 */
export function renderMarkdown(source: string): RenderedMarkdown {
  const slug = createSlugger();
  const headings: DocsHeading[] = [];
  const parser = new Marked({ gfm: true });

  parser.use({
    renderer: {
      heading(token) {
        const text = headingText(token);
        const id = slug(text);
        headings.push({ depth: token.depth, slug: id, text });
        return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      code(token) {
        const declared = (token.lang ?? "").trim().split(/\s+/)[0] ?? "";
        return highlight(token.text, declared);
      },
    },
  });

  return { html: parser.parse(source, { async: false }), headings };
}
