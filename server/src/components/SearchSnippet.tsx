import { createEffect, onMount } from "solid-js";
import docStyles from "#editor/css/document.css?inline";
import { sanitizeDocumentHtml } from "#utils/html.ts";

interface Props {
  html: string;
  class?: string;
}

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

    const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = snippetSheets();

    const content = document.createElement("div");
    content.setAttribute("part", "content");
    // A snippet is either highlighted text or, for the listing query, the first
    // 200 characters of the stored document — raw markup, cut mid-element.
    content.innerHTML = sanitizeDocumentHtml(props.html);

    shadow.querySelector('[part="content"]')?.remove();
    shadow.appendChild(content);
  }

  onMount(render);
  createEffect(() => {
    void props.html;
    render();
  });

  return <document-view ref={el} class={props.class} />;
}
