import { html, render } from "lit-html";
import type { BlockInstance, BlockType } from "#editor/blocks.ts";
import { extensions } from "#extensions/manager.ts";
import { browserLang, createTranslator } from "#utils/lang.ts";
import { CustomBlock } from "./CustomBlock.ts";

const t = createTranslator(browserLang());

/** The built-in "html" type: a sanitized preview that toggles to its raw source. */
export const htmlBlockType: BlockType = {
  title: t("HTML Block"),
  description: t("Insert raw HTML markup"),
  defaults: { html: "<p>Enter HTML content here</p>" },
  render(container, { props, update }) {
    let source = (props as { html?: string } | null)?.html ?? "";
    let isPreview = true;

    const toggleView = () => {
      isPreview = !isPreview;
      draw();
    };

    function draw() {
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
                ? html`<div class="html-block-preview"><html-block data-html=${source}></html-block></div>`
                : html`
                    <ai-textarea
                      .value=${source}
                      @change=${(e: Event) => update({ html: (e.target as HTMLInputElement).value })}
                      placeholder="Enter HTML content..."
                      class="html-block-textarea"
                    ></ai-textarea>
                  `
            }
          </div>
        `,
        container,
      );
    }

    draw();
    return {
      update(next) {
        source = (next as { html?: string } | null)?.html ?? "";
        draw();
      },
    };
  },
};

function blockTypeOf(id: string): BlockType | undefined {
  return id === "html" ? htmlBlockType : extensions.blockTypes.get(id);
}

/**
 * `CustomBlock` plus the node view that mounts its block type's UI.
 *
 * CLIENT ONLY. Importing this module pulls lit-html and the extension manager
 * into whatever bundle references it; `documentExtensions` injects it at editor
 * construction, like `MentionSuggestions`.
 *
 * Extensions load after the editor may have been created, so a block whose type
 * is not registered yet shows a placeholder and mounts once the type appears,
 * and mounts again when its extension is reloaded.
 */
export const CustomBlockNodeView = CustomBlock.extend({
  addNodeView() {
    return ({ editor, node, getPos }) => {
      const { view } = editor;
      const dom = document.createElement("div");
      dom.className = "custom-block";
      // Typing and pasting in the block's inputs must not reach the editor's or the app's shortcuts.
      for (const name of ["keydown", "paste"]) {
        dom.addEventListener(name, (event) => {
          if (event.target !== dom) event.stopPropagation();
        });
      }
      let current = node;
      let type: BlockType | undefined;
      let instance: BlockInstance;

      const update = (props: unknown) => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number") return;
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, props }));
      };

      const unmount = () => {
        instance?.destroy?.();
        instance = undefined;
        dom.replaceChildren();
      };

      const mount = () => {
        unmount();
        type = blockTypeOf(current.attrs.blockType);
        dom.dataset.block = current.attrs.blockType;
        if (!type) {
          const placeholder = document.createElement("div");
          placeholder.className = "custom-block__unknown";
          placeholder.textContent = `${t("Unknown block")}: ${current.attrs.blockType}`;
          dom.append(placeholder);
          return;
        }
        instance = type.render(dom, { props: current.attrs.props, update });
      };

      const unsubscribe = extensions.blockTypes.subscribe(() => {
        if (blockTypeOf(current.attrs.blockType) !== type) mount();
      });

      mount();

      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          if (updated.attrs.blockType !== current.attrs.blockType) return false;
          const changed = updated.attrs.props !== current.attrs.props;
          current = updated;
          if (!changed) return true;
          if (instance?.update) instance.update(current.attrs.props);
          else mount();
          return true;
        },
        // The block's own UI handles its events; only the frame selects and drags the node.
        stopEvent: (event) => event.target !== dom && dom.contains(event.target as Node),
        ignoreMutation: () => true,
        destroy() {
          unsubscribe();
          unmount();
        },
      };
    };
  },
});
