import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { html, render } from "lit-html";
import { unsafeHTML } from "lit-html/directives/unsafe-html.js";
import type { DocumentWithProperties, SpaceMember } from "~/src/api/ApiClient.ts";
import { documentIcon } from "~/src/assets/icons.ts";
import { propertyValueToText } from "~/src/utils/documentProperties.ts";
import { Mentions } from "./Mentions.ts";

type MentionItem = {
  id: string;
  label: string;
  email?: string;
  image?: string | null;
  type: "person" | "document";
  slug?: string;
};

type MentionProps = SuggestionProps<MentionItem, MentionItem>;

export interface MentionOptions {
  spaceId: string;
  documentId: string | undefined;
}

type EditorMentionState = {
  spaceId: string;
  documentId: string | undefined;
  cachedMembers: SpaceMember[] | null;
  cachedDocs: DocumentWithProperties[] | null;
};

// Keyed by editor instance so each editor has its own config + cache.
// Using `object` because the Editor type isn't importable without a side-effectful import.
const editorState = new WeakMap<object, EditorMentionState>();

export const MentionSuggestons = Mentions.extend<MentionOptions>({
  name: "mention-suggestons",

  addOptions() {
    return {
      ...this.parent?.(),
      spaceId: "",
      documentId: undefined,
      suggestion: {
        char: "@",
        allowSpaces: true,
        items: async ({
          query,
          editor,
        }: {
          query: string;
          editor: object;
        }): Promise<MentionItem[]> => {
          const state = editorState.get(editor);
          if (!state?.spaceId) {
            return [];
          }

          if (!state.cachedMembers || !state.cachedDocs) {
            const { api } = await import("~/src/api/client.ts");
            const [members, docsResponse] = await Promise.all([
              api.spaceMembers.get(state.spaceId).catch(() => []),
              api.documents
                .get(state.spaceId, { limit: 500 })
                .catch(() => ({ documents: [] })),
            ]);
            state.cachedMembers = members || [];
            state.cachedDocs = docsResponse.documents;
          }

          const q = query.toLowerCase();

          const people: MentionItem[] = state.cachedMembers
            .filter((member: SpaceMember) => {
              if (!member.user?.name) return false;
              const userName = member.user.name;
              const userEmail = member.user.email || "";
              return (
                userName.toLowerCase().includes(q) || userEmail.toLowerCase().includes(q)
              );
            })
            .slice(0, 5)
            .map((member: SpaceMember) => ({
              id: member.user?.email || member.userId || "",
              label: member.user?.name || "Unknown User",
              email: member.user?.email || "",
              image: member.user?.image || null,
              type: "person" as const,
            }));

          const docs: MentionItem[] = state.cachedDocs
            .filter((doc: DocumentWithProperties) => {
              if (state.documentId && doc.id === state.documentId) return false;
              const title = doc.properties?.title
                ? propertyValueToText(doc.properties.title)
                : "";
              return title.toLowerCase().includes(q);
            })
            .slice(0, 5)
            .map((doc: DocumentWithProperties) => ({
              id: doc.id,
              label: doc.properties?.title
                ? propertyValueToText(doc.properties.title)
                : "Untitled",
              slug: doc.slug,
              type: "document" as const,
            }));

          return [...people, ...docs];
        },

        render: () => {
          let popup: HTMLDivElement | null = null;
          let selectedIndex = 0;
          let currentItems: MentionItem[] = [];
          let lastProps: MentionProps | null = null;

          function assertClientRect(
            props: MentionProps,
          ): asserts props is MentionProps & { clientRect: () => DOMRect | null } {
            if (!props.clientRect) {
              throw new Error(
                "Mention suggestion requires clientRect to position the popup.",
              );
            }
          }

          function movePopup(props: MentionProps) {
            assertClientRect(props);
            const rect = props.clientRect();
            if (!rect || !popup) return;
            popup.style.left = `${rect.left}px`;
            popup.style.top = `${rect.bottom + 8}px`;
          }

          function selectItem(props: MentionProps, index: number) {
            const item = currentItems[index];
            if (!item) return;

            if (item.type === "document") {
              const spaceSlug = window.location.pathname.split("/").filter(Boolean)[0];
              if (!spaceSlug) return;
              const href = `/${spaceSlug}/doc/${item.id}`;

              const { editor, range } = props;
              editor
                .chain()
                .focus()
                .deleteRange(range)
                .insertContent({
                  type: "text",
                  marks: [{ type: "link", attrs: { href } }],
                  text: item.label,
                })
                .run();
            } else {
              props.command(item);
            }
          }

          function onItemMouseDown(e: MouseEvent) {
            e.preventDefault();
          }

          function onItemClick(e: MouseEvent, props: MentionProps, index: number) {
            e.stopPropagation();
            selectItem(props, index);
          }

          function onKeyDown(_props: SuggestionKeyDownProps, event: KeyboardEvent) {
            switch (event.key) {
              case "Escape":
                return true;
              case "ArrowDown":
                event.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, currentItems.length - 1);
                rerenderSelection();
                return true;
              case "ArrowUp":
                event.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                rerenderSelection();
                return true;
              case "Enter":
                event.preventDefault();
                if (lastProps) selectItem(lastProps, selectedIndex);
                return true;
              default:
                return false;
            }
          }

          function rerenderSelection() {
            if (!popup || !lastProps) return;
            renderList(lastProps);
            popup
              .querySelector(`[role="option"][aria-selected="true"]`)
              ?.scrollIntoView({ block: "nearest" });
          }

          function renderList(props: MentionProps) {
            if (!popup) return;
            lastProps = props;
            currentItems = props.items || [];
            if (currentItems.length === 0) {
              selectedIndex = 0;
              popup.style.display = "";
              movePopup(props);
              render(
                html`
                <div class="w-72 bg-background border border-neutral-100 rounded-sm shadow-lg overflow-hidden text-size-medium">
                  <p class="px-3 py-2 text-neutral-400">No results</p>
                </div>
              `,
                popup,
              );
              return;
            }

            popup.style.display = "";
            selectedIndex = Math.max(0, Math.min(selectedIndex, currentItems.length - 1));

            movePopup(props);

            const people = currentItems.filter((i) => i.type === "person");
            const docs = currentItems.filter((i) => i.type === "document");

            const getGlobalIndex = (item: MentionItem) => currentItems.indexOf(item);

            render(
              html`
              <div class="w-72 bg-background border border-neutral-100 rounded-sm shadow-lg overflow-hidden text-size-medium" role="listbox" @keydown=${(e: Event) => e.stopPropagation()}>
                <ul class="max-h-64 overflow-auto" @mousedown=${onItemMouseDown}>
                  ${
                    people.length > 0
                      ? html`
                    <li class="px-3 py-1.5 text-size-small font-medium text-neutral-400 uppercase tracking-wider select-none">People</li>
                    ${people.map((item) => {
                      const gi = getGlobalIndex(item);
                      return html`
                      <li
                        class="flex items-center gap-2 px-3 py-2 cursor-pointer ${gi === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
                        role="option"
                        aria-selected=${gi === selectedIndex}
                        @click=${(e: MouseEvent) => onItemClick(e, props, gi)}
                      >
                        ${
                          item.image
                            ? html`<img src=${item.image} alt=${item.label} class="w-6 h-6 rounded-full object-cover" />`
                            : html`<div class="w-6 h-6 rounded-full bg-neutral-200 flex items-center justify-center text-size-small text-neutral-700">${item.label ? item.label.slice(0, 1).toUpperCase() : "?"}</div>`
                        }
                        <div class="flex flex-col">
                          <span class="font-medium leading-4">${item.label}</span>
                          <span class="text-size-small text-neutral-500 leading-4">${item.email}</span>
                        </div>
                      </li>`;
                    })}
                  `
                      : ""
                  }
                  ${
                    docs.length > 0
                      ? html`
                    <li class="px-3 py-1.5 text-size-small font-medium text-neutral-400 uppercase tracking-wider select-none ${people.length > 0 ? "border-t border-neutral-100" : ""}">Documents</li>
                    ${docs.map((item) => {
                      const gi = getGlobalIndex(item);
                      return html`
                      <li
                        class="flex items-center gap-2 px-3 py-2 cursor-pointer ${gi === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
                        role="option"
                        aria-selected=${gi === selectedIndex}
                        @click=${(e: MouseEvent) => onItemClick(e, props, gi)}
                      >
                        <div class="w-6 h-6 rounded-sm flex items-center justify-center text-size-small text-neutral-500 bg-neutral-100">
                          <span class="svg-icon w-3.5 h-3.5">${unsafeHTML(documentIcon)}</span>
                        </div>
                        <span class="font-medium leading-4 truncate">${item.label}</span>
                      </li>`;
                    })}
                  `
                      : ""
                  }
                </ul>
              </div>
            `,
              popup,
            );
          }

          return {
            onStart: (props: MentionProps) => {
              if (!props) {
                throw new Error("Mention suggestion onStart requires props.");
              }

              popup = document.createElement("div");
              popup.style.position = "fixed";
              popup.style.zIndex = "50";
              popup.style.left = "0px";
              popup.style.top = "0px";
              popup.style.pointerEvents = "auto";

              popup.addEventListener("mousedown", (e) => e.preventDefault());

              document.body.appendChild(popup);

              selectedIndex = 0;
              renderList(props);
            },

            onUpdate: (props: MentionProps) => {
              if (!popup) {
                throw new Error("Mention suggestion updated after being destroyed.");
              }
              renderList(props);
            },

            onKeyDown: (props: SuggestionKeyDownProps) => {
              return onKeyDown(props, props.event);
            },

            onExit: () => {
              if (popup) {
                render(html``, popup);
                popup.remove();
                popup = null;
                currentItems = [];
              }
            },
          };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    // Register config for this editor so the items function can read it reliably.
    // We do this here because `this.options` in addProseMirrorPlugins reflects the
    // actual configured values (spaceId, documentId), whereas accessing options from
    // inside the items closure via extensionManager is unreliable in TipTap 3.x.
    if (this.editor) {
      editorState.set(this.editor, {
        spaceId: this.options.spaceId,
        documentId: this.options.documentId,
        cachedMembers: null,
        cachedDocs: null,
      });
    }
    return this.parent?.() ?? [];
  },
});
