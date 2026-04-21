import Mention from "@tiptap/extension-mention";
import { render, html } from "lit-html";
import type { SpaceMember, DocumentWithProperties } from "~/src/api/ApiClient.ts";

type MentionItem = {
  id: string;
  label: string;
  email?: string;
  image?: string | null;
  type: "person" | "document";
  slug?: string;
};

export interface MentionOptions {
  spaceId: string;
  documentId: string | undefined;
}

export const MentionSuggestons = Mention.extend<MentionOptions>({
  name: "mention-suggestons",

  parseHTML() {
    return [
      {
        tag: "user-mention",
        getAttrs: (element: any) => {
          const email = element.getAttribute("email");
          const label = element.textContent?.replace("@", "") || email;
          return {
            id: email,
            label: label,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return [
      "user-mention",
      {
        email: node.attrs.id,
      },
      `@${node.attrs.label || node.attrs.id}`,
    ];
  },

  addOptions() {
    return {
      ...this.parent?.(),
      HTMLAttributes: {
        class: "mention",
      },
      spaceId: "",
      documentId: undefined,
      suggestion: {
        char: "@",
        allowSpaces: true,
        items: (() => {
          let cachedMembers: SpaceMember[] | null = null;
          let cachedDocs: DocumentWithProperties[] | null = null;

          return async ({ query, editor }: { query: string; editor: any }): Promise<MentionItem[]> => {
          const options = editor.extensionManager.extensions.find(
            (ext: any) => ext.name === "mention-suggestons",
          )?.options;

          if (!cachedMembers || !cachedDocs) {
            const [members, docsResponse] = await Promise.all([
              api.spaceMembers.get(options.spaceId).catch(() => []),
              api.documents.get(options.spaceId).catch(() => ({ documents: [] })),
            ]);
            cachedMembers = members || [];
            cachedDocs = docsResponse?.documents || [];
          }

          const q = query.toLowerCase();

          const people: MentionItem[] = cachedMembers
            .filter((member: SpaceMember) => {
              if (!member.user?.name) return false;
              const userName = member.user.name;
              const userEmail = member.user.email || "";
              return (
                userName.toLowerCase().includes(q) ||
                userEmail.toLowerCase().includes(q)
              );
            })
            .slice(0, 5)
            .map((member: SpaceMember) => ({
              id: member.user?.email || member.userId,
              label: member.user?.name || "Unknown User",
              email: member.user?.email || "",
              image: member.user?.image || null,
              type: "person" as const,
            }));

          const docs: MentionItem[] = cachedDocs
            .filter((doc: DocumentWithProperties) => {
              if (doc.id === options.documentId) return false;
              const title = doc.properties?.title || "";
              return title.toLowerCase().includes(q);
            })
            .slice(0, 5)
            .map((doc: DocumentWithProperties) => ({
              id: doc.id,
              label: doc.properties?.title || "Untitled",
              slug: doc.slug,
              type: "document" as const,
            }));

          return [...people, ...docs];
        } })(),

        render: () => {
          let popup: HTMLDivElement | null = null;
          let selectedIndex = 0;
          let currentItems: MentionItem[] = [];
          let lastProps: any = null;

          function assertClientRect(props: any) {
            if (!props.clientRect) {
              throw new Error(
                "Mention suggestion requires clientRect to position the popup.",
              );
            }
          }

          function movePopup(props: any) {
            assertClientRect(props);
            const rect = props.clientRect();
            if (!popup) return;
            popup.style.left = `${rect.left}px`;
            popup.style.top = `${rect.bottom + 8}px`;
          }

          function selectItem(props: any, index: number) {
            const item = currentItems[index];
            if (!item) return;

            if (item.type === "document") {
              const spaceSlug = window.location.pathname.split("/").filter(Boolean)[0];
              if (!spaceSlug || !item.slug) return;
              const href = `/${spaceSlug}/doc/${item.slug}`;

              // Delete the @query range and insert a link directly
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

          function onItemClick(e: MouseEvent, props: any, index: number) {
            e.stopPropagation();
            selectItem(props, index);
          }

          function onKeyDown(_props: any, event: KeyboardEvent) {
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
                selectItem(lastProps, selectedIndex);
                return true;
              default:
                return false;
            }
          }

          function rerenderSelection() {
            if (!popup || !lastProps) return;
            renderList(lastProps);
          }

          function renderList(props: any) {
            if (!popup) return;
            lastProps = props;
            currentItems = props.items || [];
            if (currentItems.length === 0) {
              selectedIndex = 0;
            } else {
              selectedIndex = Math.max(
                0,
                Math.min(selectedIndex, currentItems.length - 1),
              );
            }

            movePopup(props);

            const people = currentItems.filter((i) => i.type === "person");
            const docs = currentItems.filter((i) => i.type === "document");

            // Build a flat index map so section rendering maps back to global indices
            const getGlobalIndex = (item: MentionItem) => currentItems.indexOf(item);

            render(
              html`
              <div class="w-72 bg-background border border-neutral-100 rounded shadow-lg overflow-hidden text-sm" role="listbox" @keydown=${(e: Event) => e.stopPropagation()}>
                <ul class="max-h-64 overflow-auto" @mousedown=${onItemMouseDown}>
                  ${people.length > 0 ? html`
                    <li class="px-3 py-1.5 text-xs font-medium text-neutral-400 uppercase tracking-wider select-none">People</li>
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
                            : html`<div class="w-6 h-6 rounded-full bg-neutral-200 flex items-center justify-center text-xs text-neutral-700">${item.label ? item.label.slice(0, 1).toUpperCase() : "?"}</div>`
                        }
                        <div class="flex flex-col">
                          <span class="font-medium leading-4">${item.label}</span>
                          <span class="text-xs text-neutral-500 leading-4">${item.email}</span>
                        </div>
                      </li>`;
                    })}
                  ` : ""}
                  ${docs.length > 0 ? html`
                    <li class="px-3 py-1.5 text-xs font-medium text-neutral-400 uppercase tracking-wider select-none ${people.length > 0 ? "border-t border-neutral-100" : ""}">Documents</li>
                    ${docs.map((item) => {
                      const gi = getGlobalIndex(item);
                      return html`
                      <li
                        class="flex items-center gap-2 px-3 py-2 cursor-pointer ${gi === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
                        role="option"
                        aria-selected=${gi === selectedIndex}
                        @click=${(e: MouseEvent) => onItemClick(e, props, gi)}
                      >
                        <div class="w-6 h-6 rounded flex items-center justify-center text-xs text-neutral-500 bg-neutral-100">
                          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                        </div>
                        <span class="font-medium leading-4 truncate">${item.label}</span>
                      </li>`;
                    })}
                  ` : ""}
                </ul>
              </div>
            `,
              popup,
            );
          }

          return {
            onStart: (props: any) => {
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

            onUpdate: (props: any) => {
              if (!popup) {
                throw new Error("Mention suggestion updated after being destroyed.");
              }
              renderList(props);
            },

            onKeyDown: (props: any) => {
              const event = props.event as KeyboardEvent;
              return onKeyDown(props, event);
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
});
