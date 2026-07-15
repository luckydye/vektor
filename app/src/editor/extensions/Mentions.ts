import Mention, { type MentionOptions } from "@tiptap/extension-mention";

export const Mentions = Mention.extend<MentionOptions>({
  parseHTML() {
    return [
      {
        tag: "user-mention",
        getAttrs: (element: HTMLElement) => {
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
    const parentOptions = this.parent?.();
    if (!parentOptions) {
      throw new Error("Mention parent options are unavailable");
    }

    return {
      ...parentOptions,
      HTMLAttributes: {
        class: "mention",
      },
    };
  },
});
