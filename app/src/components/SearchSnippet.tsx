import { createEffect, onMount } from "solid-js";
import docStyles from "#editor/css/document.css?inline";

/**
 * Renders a search-result excerpt inside a `document-view` shadow root.
 *
 * Snippets are cut out of stored document HTML, so they can carry document
 * markup — including `<style>` — into whatever page shows them. Putting them
 * behind the shadow boundary keeps those styles scoped to the excerpt instead
 * of leaking into the app shell.
 */

interface Props {
  html: string;
}

// The excerpt is a two-line teaser, not a document: flatten the block markup
// that came along with it so headings and paragraphs read as one run of text.
const SNIPPET_STYLES = `
:host { display: block; }

[part="content"] {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: var(--text-size-small);
  line-height: 1.625;
  color: var(--color-neutral-500);
}

[part="content"] * {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  font: inherit;
  color: inherit;
  background: none;
}

[part="content"] mark {
  border-radius: 0.125rem;
  background: var(--color-primary-100);
  padding: 0 0.125rem;
  color: var(--color-neutral-800);
}
`;

// A result list renders dozens of rows; parse the document stylesheet once and
// share the sheet objects across every snippet's shadow root.
let sheets: CSSStyleSheet[] | null = null;

function snippetSheets() {
  if (!sheets) {
    const base = new CSSStyleSheet();
    base.replaceSync(docStyles);
    const local = new CSSStyleSheet();
    local.replaceSync(SNIPPET_STYLES);
    sheets = [base, local];
  }
  return sheets;
}

export function SearchSnippet(props: Props) {
  let el: HTMLElement | undefined;

  function render() {
    if (!el) return;

    // `document-view` may not be upgraded here (the editor chunk loads
    // lazily), so attach the shadow root ourselves rather than waiting.
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = snippetSheets();

    const content = document.createElement("div");
    content.setAttribute("part", "content");
    content.innerHTML = props.html;

    shadow.querySelector('[part="content"]')?.remove();
    shadow.appendChild(content);
  }

  onMount(render);
  // Tracks `props.html` by reading it; a bare effect covers both the initial
  // run and every change, which is what onMounted + watch did in two pieces.
  createEffect(() => {
    void props.html;
    render();
  });

  return <document-view ref={el} />;
}
