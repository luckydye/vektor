import { html, render } from "lit-html";
import { browserLang, createTranslator } from "#utils/lang.ts";
import { HtmlBlock } from "./HtmlBlock.ts";

const t = createTranslator(browserLang());

/**
 * `HtmlBlock` plus its lit-rendered editing UI.
 *
 * CLIENT ONLY. Importing this module pulls lit-html (and in a dev build, lit's
 * dev-mode runtime) into whatever bundle references it. Keeping the schema-only
 * `HtmlBlock` separate also lets non-rendering editor use cases construct the
 * schema without a DOM rendering library. Mirrors the `Mentions` /
 * `MentionSuggestions` split: the plain node lives in `HtmlBlock.ts`, while the
 * interactive view lives here and is injected by `documentExtensions` at editor
 * construction.
 */
export const HtmlBlockNodeView = HtmlBlock.extend({
  addNodeView() {
    return ({ editor, node, getPos }) => {
      const { view } = editor;
      const dom = document.createElement("div");
      let currentNode = node;
      let isPreview = true;

      const updateHtml = (e: Event) => {
        const textarea = e.target as HTMLInputElement;
        const newHtml = textarea.value;

        if (typeof getPos === "function") {
          const pos = getPos();
          if (typeof pos === "number") {
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                "data-html": newHtml,
              }),
            );
          }
        }

        renderSource();
      };

      const toggleView = () => {
        isPreview = !isPreview;
        renderSource();
      };

      function renderSource() {
        const htmlString = currentNode.attrs["data-html"];

        render(
          html`
          <style>
            .html-block-wrapper {
              margin: 1rem 0;
              width: 100%;
              position: relative;
              white-space: normal;
            }
            .html-block-toolbar {
              position: absolute;
              top: 0.75rem;
              right: 0.75rem;
              z-index: 1;
            }
            .html-block-toggle-btn {
              align-items: center;
              background: color-mix(in srgb, var(--color-background) 88%, transparent);
              border: 1px solid var(--color-neutral-200);
              cursor: pointer;
              backdrop-filter: blur(8px);
              border-radius: 999px;
              box-shadow: 0 1px 2px rgb(15 23 42 / 8%);
              color: var(--color-neutral-600);
              display: inline-flex;
              font-size: 0.75rem;
              font-weight: 600;
              gap: 0.375rem;
              letter-spacing: 0.01em;
              line-height: 1;
              padding: 0.5rem 0.625rem;
              transition: background-color 0.15s, border-color 0.15s, color 0.15s;
            }
            .html-block-toggle-btn:hover {
              background: var(--color-background);
              border-color: var(--color-neutral-300);
              color: var(--color-neutral-900);
            }
            .html-block-toggle-btn:focus-visible {
              outline: 2px solid var(--color-primary-400);
              outline-offset: 2px;
            }
            .html-block-toggle-icon {
              height: 0.875rem;
              width: 0.875rem;
            }
            .html-block-textarea {
              width: 100%;
            }
            .html-block-textarea::part(textarea) {
              min-height: 200px;
              height: 100%;
            }
            .html-block-content {
              word-break: break-word;
              overflow-wrap: break-word;
            }
            .html-block-preview {
              width: 100%;
            }
          </style>

          <div class="html-block-wrapper">
            <div class="html-block-toolbar">
              <button
                type="button"
                class="html-block-toggle-btn"
                @click=${toggleView}
                aria-pressed=${isPreview ? "true" : "false"}
                aria-label=${isPreview ? t("Edit HTML source") : t("Show HTML preview")}
              >
                ${
                  isPreview
                    ? html`<svg class="html-block-toggle-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 3 1.5 8l4 5M10.5 3l4 5-4 5M9 1.5 7 14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> HTML`
                    : html`<svg class="html-block-toggle-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 8s2.2-4 6.5-4 6.5 4 6.5 4-2.2 4-6.5 4-6.5-4-6.5-4Z" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="1.75" fill="currentColor"/></svg> Preview`
                }
              </button>
            </div>

            ${
              isPreview
                ? html`<div class="html-block-preview"><html-block data-html=${htmlString}></html-block></div>`
                : html`
                    <div
                      @keydown=${(e: Event) => e.stopPropagation()}
                      @paste=${(e: Event) => e.stopPropagation()}
                    >
                      <ai-textarea
                        .value=${htmlString}
                        @change=${updateHtml}
                        placeholder="Enter HTML content..."
                        class="html-block-textarea"
                      ></ai-textarea>
                    </div>
                  `
            }
          </div>
        `,
          dom,
        );
      }

      renderSource();

      return {
        dom,
        update(updatedNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          renderSource();
          return true;
        },
      };
    };
  },
});
