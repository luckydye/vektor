// Extension Suggestions - Tiptap extension for handling custom suggestions from extensions
//
// This extension provides a central registry for suggestion providers that can be
// dynamically added by extensions. Each provider specifies a trigger character
// (e.g., "/" or "#") that activates the suggestion popup.
//
// Usage from an extension:
//   ctx.suggestions.register("my-commands", {
//     char: "/",
//     items: async (query) => [
//       { id: "heading", label: "Heading", description: "Insert a heading" },
//       { id: "list", label: "Bullet List", description: "Insert a list" },
//     ],
//     onSelect: (item, editor) => {
//       if (item.id === "heading") {
//         editor.chain().focus().setHeading({ level: 1 }).run();
//       }
//     },
//   });

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";

export type SuggestionItem = {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  [key: string]: unknown;
};

export type SuggestionProvider = {
  char: string;
  items: (query: string) => Promise<SuggestionItem[]> | SuggestionItem[];
  onSelect: (item: SuggestionItem, editor: Editor) => void;
};

type SuggestionState = {
  active: boolean;
  providerId: string | null;
  query: string;
  range: { from: number; to: number } | null;
  items: SuggestionItem[];
  selectedIndex: number;
};

const extensionSuggestionsPluginKey = new PluginKey("extensionSuggestions");

const providers = new Map<string, SuggestionProvider>();

export function registerSuggestionProvider(
  id: string,
  provider: SuggestionProvider,
): void {
  providers.set(id, provider);
}

export function unregisterSuggestionProvider(id: string): void {
  providers.delete(id);
}

export function getSuggestionProviders(): Map<string, SuggestionProvider> {
  return providers;
}

function createSuggestionPopup(): HTMLDivElement {
  const popup = document.createElement("div");
  popup.className = "extension-suggestions-popup";
  popup.style.cssText = `
    position: fixed;
    z-index: 50;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    max-height: 300px;
    min-width: 200px;
    max-width: 320px;
    overflow-y: auto;
    padding: 4px 0;
  `;
  return popup;
}

function renderSuggestionItems(
  popup: HTMLDivElement,
  items: SuggestionItem[],
  selectedIndex: number,
  onSelect: (index: number) => void,
): void {
  popup.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 8px 12px; color: #9ca3af; font-size: 14px;";
    empty.textContent = "No results";
    popup.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const itemEl = document.createElement("div");
    itemEl.className = "suggestion-item";
    itemEl.style.cssText = `
      padding: 8px 12px;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 2px;
      transition: background-color 0.1s;
      ${index === selectedIndex ? "background-color: #f3f4f6;" : ""}
    `;

    const labelEl = document.createElement("div");
    labelEl.style.cssText = "font-size: 14px; font-weight: 500; color: #1f2937;";
    labelEl.textContent = item.label;
    itemEl.appendChild(labelEl);

    if (item.description) {
      const descEl = document.createElement("div");
      descEl.style.cssText = "font-size: 12px; color: #6b7280;";
      descEl.textContent = item.description;
      itemEl.appendChild(descEl);
    }

    itemEl.addEventListener("mouseenter", () => {
      popup.querySelectorAll(".suggestion-item").forEach((el, i) => {
        (el as HTMLElement).style.backgroundColor = i === index ? "#f3f4f6" : "";
      });
    });

    itemEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(index);
    });

    popup.appendChild(itemEl);
  });
}

export const ExtensionSuggestions = Extension.create({
  name: "extensionSuggestions",

  addStorage() {
    return {
      state: {
        active: false,
        providerId: null,
        query: "",
        range: null,
        items: [],
        selectedIndex: 0,
      } as SuggestionState,
      popup: null as HTMLDivElement | null,
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const storage = this.storage;

    const updatePopupPosition = (
      view: { coordsAtPos: (pos: number) => { left: number; bottom: number } },
      from: number,
    ) => {
      if (!storage.popup) return;

      const coords = view.coordsAtPos(from);
      storage.popup.style.left = `${coords.left}px`;
      storage.popup.style.top = `${coords.bottom + 4}px`;
    };

    const showPopup = (
      view: { coordsAtPos: (pos: number) => { left: number; bottom: number } },
      from: number,
    ) => {
      if (!storage.popup) {
        storage.popup = createSuggestionPopup();
        document.body.appendChild(storage.popup);
      }
      storage.popup.style.display = "block";
      updatePopupPosition(view, from);
    };

    const hidePopup = () => {
      if (storage.popup) {
        storage.popup.style.display = "none";
      }
      storage.state = {
        active: false,
        providerId: null,
        query: "",
        range: null,
        items: [],
        selectedIndex: 0,
      };
    };

    const selectItem = (index: number) => {
      const state = storage.state;
      if (!state.active || !state.providerId || !state.range) return;

      const provider = providers.get(state.providerId);
      if (!provider) return;

      const item = state.items[index];
      if (!item) return;

      // Delete the trigger and query text
      editor
        .chain()
        .focus()
        .deleteRange({ from: state.range.from, to: state.range.to })
        .run();

      // Call the provider's onSelect handler
      provider.onSelect(item, editor);

      hidePopup();
    };

    const updateItems = async (providerId: string, query: string) => {
      const provider = providers.get(providerId);
      if (!provider) return;

      const items = await provider.items(query);
      storage.state.items = items;
      storage.state.selectedIndex = 0;

      if (storage.popup && storage.state.range) {
        renderSuggestionItems(storage.popup, items, 0, selectItem);
      }
    };

    return [
      new Plugin({
        key: extensionSuggestionsPluginKey,

        props: {
          handleKeyDown(_view, event) {
            if (!storage.state.active) return false;

            if (event.key === "ArrowDown") {
              event.preventDefault();
              const newIndex =
                (storage.state.selectedIndex + 1) % storage.state.items.length;
              storage.state.selectedIndex = newIndex;
              if (storage.popup) {
                renderSuggestionItems(
                  storage.popup,
                  storage.state.items,
                  newIndex,
                  selectItem,
                );
              }
              return true;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              const newIndex =
                (storage.state.selectedIndex - 1 + storage.state.items.length) %
                storage.state.items.length;
              storage.state.selectedIndex = newIndex;
              if (storage.popup) {
                renderSuggestionItems(
                  storage.popup,
                  storage.state.items,
                  newIndex,
                  selectItem,
                );
              }
              return true;
            }

            if (event.key === "Enter") {
              event.preventDefault();
              selectItem(storage.state.selectedIndex);
              return true;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              hidePopup();
              return true;
            }

            return false;
          },

          handleTextInput(view, from, _to, text) {
            // Check if typed character is a trigger
            for (const [providerId, provider] of providers) {
              if (text === provider.char) {
                // Check if at start of line or after whitespace
                const $from = view.state.doc.resolve(from);
                const textBefore = $from.parent.textContent.slice(0, $from.parentOffset);
                const isValidPosition = textBefore.length === 0 || /\s$/.test(textBefore);

                if (isValidPosition) {
                  // Start suggestion mode after the character is inserted
                  setTimeout(() => {
                    storage.state = {
                      active: true,
                      providerId,
                      query: "",
                      range: { from, to: from + 1 },
                      items: [],
                      selectedIndex: 0,
                    };
                    showPopup(view, from);
                    updateItems(providerId, "");
                  }, 0);
                }
              }
            }

            return false;
          },
        },

        view() {
          return {
            update(view, _prevState) {
              if (!storage.state.active || !storage.state.range) return;

              const { from } = view.state.selection;
              const startPos = storage.state.range.from;

              // Check if cursor moved before the trigger
              if (from <= startPos) {
                hidePopup();
                return;
              }

              // Extract current query (text after trigger character)
              const textAfterTrigger = view.state.doc.textBetween(startPos + 1, from, "");

              // Check for spaces or if query changed
              if (textAfterTrigger !== storage.state.query) {
                storage.state.query = textAfterTrigger;
                storage.state.range = { from: startPos, to: from };

                if (storage.state.providerId) {
                  updateItems(storage.state.providerId, textAfterTrigger);
                }

                updatePopupPosition(view, startPos);
              }
            },

            destroy() {
              if (storage.popup) {
                storage.popup.remove();
                storage.popup = null;
              }
            },
          };
        },
      }),
    ];
  },
});
