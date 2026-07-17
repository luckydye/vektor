import { type Editor, Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import {
  addIcon,
  dateIcon,
  extensionIcon,
  fileAttachmentIcon,
  fourColumnsIcon,
  htmlIcon,
  imageIcon,
  tableIcon,
  threeColumnsIcon,
  twoColumnsIcon,
  videoIcon,
} from "~/src/assets/icons.ts";
import { extensions } from "~/src/utils/extensions.ts";
import { handleFileAttachmentUpload } from "./FileAttachment.ts";
import { handleImageUpload } from "./ImageUpload.ts";
import { handleVideoUpload } from "./VideoUpload.ts";

export interface TrailingNodePlusOptions {
  spaceId: string;
  documentId?: string;
}

interface ContentItem {
  title: string;
  description: string;
  icon: string;
  command: (editor: Editor) => void;
}

type ColumnLayoutCommandChain = {
  setColumnLayout(options: { columns: number }): { run(): boolean };
};

function createContentItems(spaceId: string, documentId?: string): ContentItem[] {
  const items: ContentItem[] = [
    {
      title: "Table",
      description: "Insert a table",
      icon: tableIcon,
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
      icon: imageIcon,
      command: (editor) => {
        handleImageUpload(editor, spaceId, documentId);
      },
    },
    {
      title: "Video",
      description: "Upload and insert a video",
      icon: videoIcon,
      command: (editor) => {
        handleVideoUpload(editor, spaceId, documentId);
      },
    },
    {
      title: "File/Attachment",
      description: "Upload and insert any file",
      icon: fileAttachmentIcon,
      command: (editor) => {
        handleFileAttachmentUpload(editor, spaceId, documentId);
      },
    },
    {
      title: "2 Columns",
      description: "Insert a 2-column layout",
      icon: twoColumnsIcon,
      command: (editor) => {
        (editor.chain().focus() as unknown as ColumnLayoutCommandChain)
          .setColumnLayout({ columns: 2 })
          .run();
      },
    },
    {
      title: "3 Columns",
      description: "Insert a 3-column layout",
      icon: threeColumnsIcon,
      command: (editor) => {
        (editor.chain().focus() as unknown as ColumnLayoutCommandChain)
          .setColumnLayout({ columns: 3 })
          .run();
      },
    },
    {
      title: "4 Columns",
      description: "Insert a 4-column layout",
      icon: fourColumnsIcon,
      command: (editor) => {
        (editor.chain().focus() as unknown as ColumnLayoutCommandChain)
          .setColumnLayout({ columns: 4 })
          .run();
      },
    },
    {
      title: "HTML Block",
      description: "Insert raw HTML markup",
      icon: htmlIcon,
      command: (editor) => {
        editor.chain().focus().insertHtmlBlock().run();
      },
    },
    {
      title: "Date",
      description: "Insert a date picker",
      icon: dateIcon,
      command: (editor) => {
        editor.chain().focus().insertDatePicker().run();
      },
    },
  ];

  for (const { extensionId, route } of extensions.getRoutesWithPlacement("document")) {
    items.push({
      title: route.menuItem?.title || route.title || extensionId,
      description: route.description || "Extension view",
      icon: route.menuItem?.icon || extensionIcon,
      command: (editor) => {
        editor
          .chain()
          .focus()
          .insertExtensionView({ extensionId, routePath: route.path })
          .run();
      },
    });
  }

  return items;
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
    const popupPadding = 8;
    const popupGap = 8;

    // Slash command state
    let slashPopup: HTMLDivElement | null = null;
    let slashSelectedIndex = 0;
    let slashItems: ContentItem[] = [];
    let allSlashItems: ContentItem[] = [];
    let slashRange: { from: number; to: number } | null = null;
    let slashQuery = "";

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
          renderPopup(true);
          break;
        case "ArrowUp":
          e.preventDefault();
          selectedIndex = Math.max(selectedIndex - 1, 0);
          renderPopup(true);
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

    function renderPopup(scroll = false) {
      if (!popup) return;

      render(
        html`
          <div
            class="w-80 bg-background border border-neutral-100 rounded-lg shadow-xl overflow-hidden text-size-medium"
            role="listbox"
            @mousedown=${(e: Event) => e.preventDefault()}
          >
            <ul class="max-h-60 overflow-auto py-2">
              ${items.map(
                (item, index) => html`
                  <li
                    class="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer ${index === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
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
                      class="w-5 h-5 flex items-center justify-center text-neutral-600 shrink-0"
                    >
                      ${item.icon.startsWith("<svg") ? unsafeHTML(item.icon) : item.icon}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="font-medium text-neutral-900 text-size-medium">${item.title}</div>
                      <div class="text-size-small text-neutral-400">${item.description}</div>
                    </div>
                  </li>
                `,
              )}
            </ul>
          </div>
        `,
        popup,
      );

      if (scroll) {
        const activeEl = popup.querySelector(
          `[role="option"][aria-selected="true"]`,
        ) as HTMLElement | null;
        activeEl?.scrollIntoView({ block: "nearest" });
      }
    }

    function placePopup(buttonRect: DOMRect) {
      if (!popup) return;

      const popupRect = popup.getBoundingClientRect();
      const popupWidth = popupRect.width || 320;
      const popupHeight = popupRect.height || 260;
      const maxLeft = window.innerWidth - popupWidth - popupPadding;
      const maxTop = window.innerHeight - popupHeight - popupPadding;
      const aboveTop = buttonRect.top - popupHeight - popupGap;
      const belowTop = buttonRect.bottom + popupGap;
      const top =
        aboveTop >= popupPadding
          ? aboveTop
          : belowTop <= maxTop
            ? belowTop
            : Math.min(Math.max(aboveTop, popupPadding), Math.max(popupPadding, maxTop));
      const left = Math.min(
        Math.max(buttonRect.left, popupPadding),
        Math.max(popupPadding, maxLeft),
      );

      popup.style.left = `${left}px`;
      popup.style.top = `${top}px`;
      popup.style.bottom = "auto";
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
      popup.style.left = `${popupPadding}px`;
      popup.style.top = `${popupPadding}px`;
      popup.style.maxWidth = `calc(100vw - ${popupPadding * 2}px)`;
      popup.style.maxHeight = `calc(100vh - ${popupPadding * 2}px)`;
      popup.style.pointerEvents = "auto";

      popup.addEventListener("mousedown", (e) => e.preventDefault());

      document.body.appendChild(popup);
      renderPopup();
      placePopup(buttonRect);

      // Add event listeners after a brief delay to avoid immediate close
      setTimeout(() => {
        document.addEventListener("click", handleOutsideClick);
        document.addEventListener("keydown", handleKeyDown);
      }, 0);
    }

    function filterSlashItems(query: string) {
      const q = query.toLowerCase().trim();
      if (q === slashQuery) return;
      slashQuery = q;
      slashItems = q
        ? allSlashItems.filter(
            (item) =>
              item.title.toLowerCase().includes(q) ||
              item.description.toLowerCase().includes(q),
          )
        : allSlashItems;
      slashSelectedIndex = 0;
    }

    function closeSlashPopup() {
      if (slashPopup) {
        render(html``, slashPopup);
        slashPopup.remove();
        slashPopup = null;
        slashSelectedIndex = 0;
        slashRange = null;
        slashQuery = "";
      }
      document.removeEventListener("click", handleSlashOutsideClick);
    }

    function handleSlashOutsideClick(e: MouseEvent) {
      if (slashPopup && !slashPopup.contains(e.target as Node)) {
        closeSlashPopup();
      }
    }

    function selectSlashItem(index: number) {
      const item = slashItems[index];
      if (!item || !slashRange) return;

      const editor = extension.editor;
      if (editor) {
        editor
          .chain()
          .focus()
          .deleteRange({ from: slashRange.from, to: slashRange.to })
          .run();
        item.command(editor);
      }

      closeSlashPopup();
    }

    function renderSlashPopup(scroll = false) {
      if (!slashPopup) return;

      render(
        html`
          <div
            class="w-80 bg-background border border-neutral-100 rounded-lg shadow-xl overflow-hidden text-size-medium"
            role="listbox"
            @mousedown=${(e: Event) => e.preventDefault()}
          >
            <ul class="max-h-60 overflow-auto py-2">
              ${
                slashItems.length === 0
                  ? html`<li class="px-4 py-2.5 text-neutral-400 text-size-small">No results</li>`
                  : slashItems.map(
                      (item, index) => html`
                        <li
                          class="flex items-start gap-3 px-4 py-2.5 cursor-pointer ${index === slashSelectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
                          role="option"
                          aria-selected=${index === slashSelectedIndex}
                          @click=${(e: MouseEvent) => {
                            e.stopPropagation();
                            selectSlashItem(index);
                          }}
                          @mouseenter=${() => {
                            slashSelectedIndex = index;
                            renderSlashPopup();
                          }}
                        >
                          <div
                            class="w-5 h-5 flex items-center justify-center text-neutral-600 shrink-0"
                          >
                            ${item.icon.startsWith("<svg") ? unsafeHTML(item.icon) : item.icon}
                          </div>
                          <div class="flex-1 min-w-0">
                            <div class="font-medium text-neutral-900 text-size-medium">${item.title}</div>
                            <div class="text-size-small text-neutral-400">${item.description}</div>
                          </div>
                        </li>
                      `,
                    )
              }
            </ul>
          </div>
        `,
        slashPopup,
      );

      if (scroll) {
        const activeEl = slashPopup.querySelector(
          `[role="option"][aria-selected="true"]`,
        ) as HTMLElement | null;
        activeEl?.scrollIntoView({ block: "nearest" });
      }
    }

    function placeSlashPopupAtCursor(
      view: {
        coordsAtPos: (pos: number) => { left: number; bottom: number; top: number };
      },
      pos: number,
    ) {
      if (!slashPopup) return;

      const coords = view.coordsAtPos(pos);
      const popupRect = slashPopup.getBoundingClientRect();
      const popupWidth = popupRect.width || 320;
      const popupHeight = popupRect.height || 260;
      const belowTop = coords.bottom + popupGap;
      const aboveTop = coords.top - popupHeight - popupGap;
      const top =
        belowTop + popupHeight + popupPadding <= window.innerHeight
          ? belowTop
          : aboveTop >= popupPadding
            ? aboveTop
            : belowTop;
      const left = Math.min(
        Math.max(coords.left, popupPadding),
        window.innerWidth - popupWidth - popupPadding,
      );

      slashPopup.style.left = `${left}px`;
      slashPopup.style.top = `${top}px`;
    }

    function openSlashPopup(view: {
      coordsAtPos: (pos: number) => { left: number; bottom: number; top: number };
    }) {
      if (slashPopup) closeSlashPopup();

      allSlashItems = createContentItems(spaceId, documentId);
      slashItems = allSlashItems;
      slashSelectedIndex = 0;

      slashPopup = document.createElement("div");
      slashPopup.style.position = "fixed";
      slashPopup.style.zIndex = "50";
      slashPopup.style.left = `${popupPadding}px`;
      slashPopup.style.top = `${popupPadding}px`;
      slashPopup.style.maxWidth = `calc(100vw - ${popupPadding * 2}px)`;
      slashPopup.style.maxHeight = `calc(100vh - ${popupPadding * 2}px)`;
      slashPopup.style.pointerEvents = "auto";

      slashPopup.addEventListener("mousedown", (e) => e.preventDefault());

      document.body.appendChild(slashPopup);
      renderSlashPopup();

      if (slashRange) {
        placeSlashPopupAtCursor(view, slashRange.from);
      }

      setTimeout(() => {
        document.addEventListener("click", handleSlashOutsideClick);
      }, 0);
    }

    function syncTrailingButtonVisibility(view: EditorView) {
      const button = view.dom.querySelector<HTMLElement>(".trailing-node-plus-button");
      if (!button) return;

      const { selection } = view.state;
      const buttonRect = button.getBoundingClientRect();
      const cursor = view.coordsAtPos(selection.from);
      const cursorMiddle = (cursor.top + cursor.bottom) / 2;
      const isSameRow =
        cursorMiddle >= buttonRect.top && cursorMiddle <= buttonRect.bottom;

      button.style.visibility = isSameRow ? "hidden" : "";
      button.style.pointerEvents = isSameRow ? "none" : "";
    }

    return [
      new Plugin({
        key: new PluginKey("trailingNodePlus"),
        props: {
          decorations(state) {
            const { doc } = state;
            const decorations: Decoration[] = [];

            // Check if the document ends with an empty paragraph
            const lastNode = doc.lastChild;

            // Render the button if:
            // 1. Last node is a paragraph
            // 2. It's empty
            // Visibility is row-aware and is updated from the plugin view below.
            if (
              lastNode &&
              lastNode.type.name === "paragraph" &&
              lastNode.content.size === 0
            ) {
              const widget = document.createElement("button");
              widget.type = "button";
              widget.className = "trailing-node-plus-button";
              widget.contentEditable = "false";
              widget.innerHTML = `
                  ${addIcon}
                  <span>Add content</span>
                `;

              widget.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();

                const rect = widget.getBoundingClientRect();
                openPopup(rect);
              });

              decorations.push(
                Decoration.widget(doc.content.size, widget, {
                  side: 1,
                  key: "trailing-plus-button",
                }),
              );
            }

            return DecorationSet.create(doc, decorations);
          },
        },
        view(view) {
          queueMicrotask(() => syncTrailingButtonVisibility(view));

          return {
            update(updatedView) {
              syncTrailingButtonVisibility(updatedView);
            },
          };
        },
      }),
      new Plugin({
        key: new PluginKey("slashCommands"),
        props: {
          handleKeyDown(_view, event) {
            if (!slashPopup) return false;

            switch (event.key) {
              case "Escape":
                event.preventDefault();
                closeSlashPopup();
                return true;
              case "ArrowDown":
                event.preventDefault();
                slashSelectedIndex = Math.min(
                  slashSelectedIndex + 1,
                  slashItems.length - 1,
                );
                renderSlashPopup(true);
                return true;
              case "ArrowUp":
                event.preventDefault();
                slashSelectedIndex = Math.max(slashSelectedIndex - 1, 0);
                renderSlashPopup(true);
                return true;
              case "Enter":
                event.preventDefault();
                selectSlashItem(slashSelectedIndex);
                return true;
            }

            return false;
          },

          handleTextInput(view, from, _to, text) {
            if (text !== "/") return false;

            const $from = view.state.doc.resolve(from);
            const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
            const isValidPosition = textBefore.length === 0 || /\s$/.test(textBefore);

            if (isValidPosition) {
              setTimeout(() => {
                slashRange = { from, to: from + 1 };
                openSlashPopup(view);
              }, 0);
            }

            return false;
          },
        },

        view() {
          return {
            update(view) {
              if (!slashPopup || !slashRange) return;

              const { from } = view.state.selection;

              if (from <= slashRange.from) {
                closeSlashPopup();
                return;
              }

              const query = view.state.doc.textBetween(slashRange.from + 1, from, "");
              slashRange = { from: slashRange.from, to: from };
              filterSlashItems(query);
              renderSlashPopup();
              placeSlashPopupAtCursor(view, slashRange.from);
            },

            destroy() {
              closeSlashPopup();
            },
          };
        },
      }),
    ];
  },

  // Ensure there's always a trailing empty paragraph
  onCreate() {
    this.editor.commands.command(({ tr, state }) => {
      const { doc } = state;
      const lastNode = doc.lastChild;

      if (lastNode?.type.name !== "paragraph" || lastNode.content.size > 0) {
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

      if (lastNode?.type.name !== "paragraph" || lastNode.content.size > 0) {
        tr.insert(doc.content.size, state.schema.nodes.paragraph.create());
        return true;
      }

      return false;
    });
  },
});
