import { mergeAttributes, Node } from "@tiptap/core";
import type { CommandProps } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    datePicker: {
      insertDatePicker: (attributes?: { date?: string }) => ReturnType;
    };
  }
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-AU", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export const DatePicker = Node.create({
  name: "datePicker",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      "data-date": {
        default: new Date().toISOString().split("T")[0],
        parseHTML: (element) =>
          element.getAttribute("data-date") || new Date().toISOString().split("T")[0],
        renderHTML: (attributes) => {
          return {
            "data-date": attributes["data-date"],
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "date-picker",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const dateValue =
      HTMLAttributes["data-date"] || new Date().toISOString().split("T")[0];
    return ["date-picker", mergeAttributes(HTMLAttributes), formatDate(dateValue)];
  },

  addCommands() {
    return {
      insertDatePicker:
        (attributes?: { date?: string }) =>
        ({ commands }: CommandProps) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              "data-date": attributes?.date || new Date().toISOString().split("T")[0],
            },
          });
        },
    };
  },

  addNodeView() {
    return ({ editor, node, getPos }) => {
      const { view } = editor;
      const dom = document.createElement("span");
      dom.classList.add("date-picker-wrapper");

      let inputElement: HTMLInputElement | null = null;

      function updateDate(e: Event) {
        const input = e.target as HTMLInputElement;
        const newDate = input.value;

        if (typeof getPos === "function") {
          const pos = getPos();
          if (pos !== undefined) {
            view.dispatch(
              view.state.tr.setNodeMarkup(pos, undefined, {
                "data-date": newDate,
              }),
            );
          }
        }
      }

      function renderContent() {
        const dateValue = node.attrs["data-date"];
        const isEditable = editor.isEditable;

        dom.innerHTML = "";

        const style = document.createElement("style");
        style.textContent = `
          .date-picker-wrapper {
            display: inline-block;
            vertical-align: baseline;
          }
          .date-picker-input {
            padding: 0.25rem 0.5rem;
            border: 1px solid var(--color-neutral-300, #ccc);
            border-radius: 0.25rem;
            font-size: 0.875rem;
            cursor: pointer;
            background: var(--color-neutral-50, #fafafa);
            transition: border-color 0.2s;
          }
          .date-picker-input:hover {
            border-color: var(--color-neutral-400, #999);
          }
          .date-picker-input:focus {
            outline: none;
            border-color: var(--color-primary-500, #3b82f6);
          }
          date-picker {
            padding: 0.25rem 0.5rem;
            border-radius: 0.25rem;
            background: var(--color-neutral-100, #f5f5f5);
            font-size: 0.875rem;
            color: var(--color-neutral-700, #374151);
            display: inline-block;
          }
        `;
        dom.appendChild(style);

        if (isEditable) {
          inputElement = document.createElement("input");
          inputElement.type = "date";
          inputElement.className = "date-picker-input";
          inputElement.value = dateValue;
          inputElement.addEventListener("change", updateDate);
          inputElement.addEventListener("click", (e) => e.stopPropagation());
          inputElement.addEventListener("keydown", (e) => e.stopPropagation());
          dom.appendChild(inputElement);
        } else {
          const datePickerElement = document.createElement("date-picker");
          datePickerElement.setAttribute("data-date", dateValue);
          datePickerElement.textContent = formatDate(dateValue);
          dom.appendChild(datePickerElement);
        }
      }

      renderContent();

      const updateHandler = () => renderContent();
      editor.on("update", updateHandler);

      return {
        dom,
        destroy() {
          editor.off("update", updateHandler);
          if (inputElement) {
            inputElement.removeEventListener("change", updateDate);
          }
        },
      };
    };
  },
});
