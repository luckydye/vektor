import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { render, html } from "lit-html";
import { handleImageUpload } from "./ImageUpload.ts";

export interface TrailingNodePlusOptions {
  spaceId: string;
  documentId?: string;
}

interface ContentItem {
  title: string;
  description: string;
  icon: string;
  command: (editor: any) => void;
}

function createContentItems(spaceId: string, documentId?: string): ContentItem[] {
  return [
    {
      title: "Table",
      description: "Insert a table",
      icon: "⊞",
      command: (editor) => {
        editor
          .chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
      },
    },
    {
      title: "Image",
      description: "Upload and insert an image",
      icon: "🖼️",
      command: (editor) => {
        handleImageUpload(editor, spaceId, documentId);
      },
    },
    {
      title: "2 Columns",
      description: "Insert a 2-column layout",
      icon: "⫴⫴",
      command: (editor) => {
        editor.chain().focus().setColumnLayout({ columns: 2 }).run();
      },
    },
    {
      title: "3 Columns",
      description: "Insert a 3-column layout",
      icon: "⫴⫴⫴",
      command: (editor) => {
        editor.chain().focus().setColumnLayout({ columns: 3 }).run();
      },
    },
    {
      title: "4 Columns",
      description: "Insert a 4-column layout",
      icon: "⫴⫴⫴⫴",
      command: (editor) => {
        editor.chain().focus().setColumnLayout({ columns: 4 }).run();
      },
    },
    {
      title: "HTML Block",
      description: "Insert raw HTML markup",
      icon: "<>",
      command: (editor) => {
        editor.chain().focus().insertHtmlBlock().run();
      },
    },
    {
      title: "Date",
      description: "Insert a date picker",
      icon: "📅",
      command: (editor) => {
        editor.chain().focus().insertDatePicker().run();
      },
    },
  ];
}

export const TrailingNodePlus = Extension.create<TrailingNodePlusOptions>({
  name: "trailingNodePlus",

  addOptions() {
    return {
      spaceId: "",
      documentId: undefined,
    };
  },

  addProseMirrorPlugins() {
    const extension = this;
    const spaceId = this.options.spaceId;
    const documentId = this.options.documentId;

    let popup: HTMLDivElement | null = null;
    let selectedIndex = 0;
    let items: ContentItem[] = [];

    function closePopup() {
      if (popup) {
        render(html``, popup);
        popup.remove();
        popup = null;
        selectedIndex = 0;
      }
      document.removeEventListener("click", handleOutsideClick);
      document.removeEventListener("keydown", handleKeyDown);
    }

    function handleOutsideClick(e: MouseEvent) {
      if (popup && !popup.contains(e.target as Node)) {
        closePopup();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (!popup) return;

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          closePopup();
          break;
        case "ArrowDown":
          e.preventDefault();
          selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
          renderPopup();
          break;
        case "ArrowUp":
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          renderPopup();
          break;
        case "Enter":
          e.preventDefault();
          selectItem(selectedIndex);
          break;
      }
    }

    function selectItem(index: number) {
      const item = items[index];
      if (!item) return;

      const editor = extension.editor;
      if (editor) {
        // Focus the last empty paragraph first
        const { doc } = editor.state;
        const lastNode = doc.lastChild;
        const lastNodePos = doc.content.size - (lastNode?.nodeSize || 0);
        editor
          .chain()
          .focus(lastNodePos + 1)
          .run();

        // Execute the command
        item.command(editor);
      }

      closePopup();
    }

    function renderPopup() {
      if (!popup) return;

      render(
        html`
          <div
            class="w-80 bg-background border border-neutral-100 rounded-lg shadow-xl overflow-hidden text-sm"
            role="listbox"
            @mousedown=${(e: Event) => e.preventDefault()}
          >
            <ul class="max-h-60 overflow-auto py-2">
              ${items.map(
                (item, index) => html`
                  <li
                    class="flex items-start gap-3 px-4 py-2.5 cursor-pointer transition-colors ${index === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
                    role="option"
                    aria-selected=${index === selectedIndex}
                    @click=${(e: MouseEvent) => {
                      e.stopPropagation();
                      selectItem(index);
                    }}
                    @mouseenter=${() => {
                      selectedIndex = index;
                      renderPopup();
                    }}
                  >
                    <div
                      class="w-10 h-10 flex items-center justify-center bg-neutral-300 rounded font-bold text-neutral-900 text-sm shrink-0"
                    >
                      ${item.icon}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-medium text-neutral-900 text-sm">${item.title}</div>
                      <div class="text-xs text-neutral-900 mt-0.5">${item.description}</div>
                    </div>
                  </li>
                `,
              )}
            </ul>
          </div>
        `,
        popup,
      );
    }

    function openPopup(buttonRect: DOMRect) {
      if (popup) {
        closePopup();
      }

      items = createContentItems(spaceId, documentId);
      selectedIndex = 0;

      popup = document.createElement("div");
      popup.style.position = "fixed";
      popup.style.zIndex = "50";
      popup.style.left = `${buttonRect.left}px`;
      popup.style.bottom = `${window.innerHeight - buttonRect.top + 8}px`;
      popup.style.pointerEvents = "auto";

      popup.addEventListener("mousedown", (e) => e.preventDefault());

      document.body.appendChild(popup);
      renderPopup();

      // Add event listeners after a brief delay to avoid immediate close
      setTimeout(() => {
        document.addEventListener("click", handleOutsideClick);
        document.addEventListener("keydown", handleKeyDown);
      }, 0);
    }

    return [
      new Plugin({
        key: new PluginKey("trailingNodePlus"),
        props: {
          decorations(state) {
            const { doc, selection } = state;
            const decorations: Decoration[] = [];

            // Check if the document ends with an empty paragraph
            const lastNode = doc.lastChild;
            const lastNodePos = doc.content.size - (lastNode?.nodeSize || 0);

            // Only show button if:
            // 1. Last node is a paragraph
            // 2. It's empty
            // 3. Selection is not in the last node
            if (
              lastNode &&
              lastNode.type.name === "paragraph" &&
              lastNode.content.size === 0
            ) {
              const isLastNodeFocused =
                selection.from >= lastNodePos && selection.to <= doc.content.size;

              if (!isLastNodeFocused) {
                const widget = document.createElement("button");
                widget.type = "button";
                widget.className = "trailing-node-plus-button";
                widget.contentEditable = "false";
                widget.innerHTML = `
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  </svg>
                  <span>Add content</span>
                `;

                widget.addEventListener("click", (e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  const rect = widget.getBoundingClientRect();
                  openPopup(rect);
                });

                decorations.push(
                  Decoration.widget(lastNodePos + 1, widget, {
                    side: 0,
                    key: "trailing-plus-button",
                  }),
                );
              }
            }

            return DecorationSet.create(doc, decorations);
          },
        },
      }),
    ];
  },

  // Ensure there's always a trailing empty paragraph
  onCreate() {
    this.editor.commands.command(({ tr, state }) => {
      const { doc } = state;
      const lastNode = doc.lastChild;

      if (!lastNode || lastNode.type.name !== "paragraph" || lastNode.content.size > 0) {
        tr.insert(doc.content.size, state.schema.nodes.paragraph.create());
        return true;
      }

      return false;
    });
  },

  onUpdate() {
    this.editor.commands.command(({ tr, state }) => {
      const { doc } = state;
      const lastNode = doc.lastChild;

      if (!lastNode || lastNode.type.name !== "paragraph" || lastNode.content.size > 0) {
        tr.insert(doc.content.size, state.schema.nodes.paragraph.create());
        return true;
      }

      return false;
    });
  },
});
