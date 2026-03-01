import Mention from "@tiptap/extension-mention";
import { render, html } from "lit-html";
import type { SpaceMember } from "~/src/api/client.ts";

export interface MentionOptions {
  spaceId: string;
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
      suggestion: {
        char: "@",
        allowSpaces: true,
        items: async ({ query, editor }: { query: string; editor: any }) => {
          const options = editor.extensionManager.extensions.find(
            (ext: any) => ext.name === "mention-suggestons",
          )?.options;

          const members = (await api.spaceMembers.get(options.spaceId)) || [];

          if (!members || members.length === 0) {
            return [];
          }

          return members
            .filter((member: SpaceMember) => {
              const userName = member.user?.name || "";
              const userEmail = member.user?.email || "";
              return (
                userName.toLowerCase().includes(query.toLowerCase()) ||
                userEmail.toLowerCase().includes(query.toLowerCase())
              );
            })
            .slice(0, 5)
            .map((member: SpaceMember) => ({
              id: member.user?.email || member.userId,
              label: member.user?.name || "Unknown User",
              email: member.user?.email || "",
              image: member.user?.image || null,
            }));
        },

        render: () => {
          let popup: HTMLDivElement | null = null;
          let selectedIndex = 0;
          let currentItems: Array<any> = [];
          let propsRef: any = null;

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
            // command expects the chosen item
            props.command(item);
          }

          function onItemMouseDown(e: MouseEvent) {
            // Prevent editor losing focus or the suggestion closing before click handler runs.
            e.preventDefault();
          }

          function onItemClick(e: MouseEvent, props: any, index: number) {
            e.stopPropagation();
            selectItem(props, index);
          }

          function onKeyDown(props: any, event: KeyboardEvent) {
            switch (event.key) {
              case "Escape":
                return true; // let the suggestion lifecycle handle closing
              case "ArrowDown":
                selectedIndex = Math.min(selectedIndex + 1, currentItems.length - 1);
                renderList(props);
                return true;
              case "ArrowUp":
                selectedIndex = Math.max(selectedIndex - 1, 0);
                renderList(props);
                return true;
              case "Enter":
                // Prevent default form submissions or editor handling
                event.preventDefault();
                selectItem(props, selectedIndex);
                return true;
              default:
                return false;
            }
          }

          function renderList(props: any) {
            propsRef = props;
            if (!popup) return;
            currentItems = props.items || [];
            // Ensure selectedIndex is in-range
            if (currentItems.length === 0) {
              selectedIndex = 0;
            } else {
              selectedIndex = Math.max(
                0,
                Math.min(selectedIndex, currentItems.length - 1),
              );
            }

            // Position first — will throw if missing so we fail loudly
            movePopup(props);

            render(
              html`
              <div class="w-64 bg-background border border-neutral-100 rounded shadow-lg overflow-hidden text-sm" role="listbox" @keydown=${(e: Event) => e.stopPropagation()}>
                <ul class="max-h-56 overflow-auto" @mousedown=${onItemMouseDown}>
                  ${currentItems.map(
                    (item: any, index: number) => html`
                    <li
                      class="flex items-center gap-2 px-3 py-2 cursor-pointer ${index === selectedIndex ? "bg-neutral-100" : "hover:bg-neutral-50"}"
                      role="option"
                      aria-selected=${index === selectedIndex}
                      @click=${(e: MouseEvent) => onItemClick(e, props, index)}
                    >
                      ${
                        item.image
                          ? html`
                        <img src=${item.image} alt=${item.label} class="w-6 h-6 rounded-full object-cover" />
                      `
                          : html`
                        <div class="w-6 h-6 rounded-full bg-neutral-200 flex items-center justify-center text-xs text-neutral-700">
                          ${item.label ? item.label.slice(0, 1).toUpperCase() : "?"}
                        </div>
                      `
                      }
                      <div class="flex flex-col">
                        <span class="font-medium leading-4">${item.label}</span>
                        <span class="text-xs text-neutral-500 leading-4">${item.email}</span>
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

          return {
            onStart: (props: any) => {
              if (!props) {
                throw new Error("Mention suggestion onStart requires props.");
              }

              // create popup container
              popup = document.createElement("div");
              popup.style.position = "fixed";
              popup.style.zIndex = "50";
              popup.style.left = "0px";
              popup.style.top = "0px";
              popup.style.pointerEvents = "auto";

              // Prevent native focus changes when clicking items
              popup.addEventListener("mousedown", (e) => e.preventDefault());

              document.body.appendChild(popup);

              // render first time
              selectedIndex = 0;
              renderList(props);
            },

            onUpdate: (props: any) => {
              if (!popup) {
                throw new Error("Mention suggestion updated after being destroyed.");
              }
              // update items and reposition
              renderList(props);
            },

            onKeyDown: (props: any) => {
              // props.event is passed by tiptap
              const event = props.event as KeyboardEvent;
              return onKeyDown(props, event);
            },

            onExit: () => {
              if (popup) {
                // clear lit-html contents and remove from DOM
                render(html``, popup);
                popup.remove();
                popup = null;
                currentItems = [];
                propsRef = null;
              }
            },
          };
        },
      },
    };
  },
});
