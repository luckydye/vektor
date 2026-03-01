import { Mark } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Connection } from "~/src/api/client.ts";
import { detectAppType } from "~/src/utils/utils.ts";

export interface TicketLinkOptions {
  connections: Connection[];
}

function getTicketPattern(
  appType: "jira" | "youtrack" | "linear" | "github" | "gitlab",
): RegExp {
  switch (appType) {
    case "jira":
    case "youtrack":
      return /\b[A-Z]{2,}-\d+\b/g;
    case "linear":
      return /\b[A-Z]{3,}-\d+\b/g;
    case "github":
    case "gitlab":
      return /\b#\d+\b/g;
    default:
      return /\b[A-Z]{2,}-\d+\b/g;
  }
}

export const TicketLink = Mark.create<TicketLinkOptions>({
  name: "ticketLink",

  priority: 1000,

  addOptions() {
    return {
      connections: [],
    };
  },

  addStorage() {
    return {
      connections: [] as Connection[],
    };
  },

  addAttributes() {
    return {
      ticketId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-ticket-id"),
        renderHTML: (attributes) => {
          return {
            "data-ticket-id": attributes.ticketId,
          };
        },
      },
      connectionLabel: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-connection-id"),
        renderHTML: (attributes) => ({
          "data-connection-label": attributes.connectionLabel,
        }),
      },
      connectionUrl: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-connection-id"),
        renderHTML: (attributes) => ({
          "data-connection-url": attributes.connectionUrl,
        }),
      },
      connectionId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-connection-id"),
        renderHTML: (attributes) => ({
          "data-connection-id": attributes.connectionId,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "ticket-link",
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["ticket-link", HTMLAttributes, 0];
  },

  addProseMirrorPlugins() {
    const markType = this.type;
    const getConnections = () => this.storage.connections;

    return [
      new Plugin({
        key: new PluginKey("ticketLinkApplier"),
        appendTransaction: (transactions, oldState, newState) => {
          const connections = getConnections();
          if (!connections || connections.length === 0) {
            return null;
          }

          const docChanged = transactions.some((transaction) => transaction.docChanged);
          if (!docChanged) {
            return null;
          }

          const tr = newState.tr;
          let modified = false;

          newState.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) {
              return;
            }

            const text = node.text;
            const nodeStart = pos;
            const nodeEnd = pos + node.nodeSize;

            // First, remove all ticket link marks from this text node
            if (node.marks.some((mark) => mark.type === markType)) {
              tr.removeMark(nodeStart, nodeEnd, markType);
              modified = true;
            }

            // Then, apply marks only to matched patterns
            for (const connection of connections) {
              const appType = detectAppType(connection.label);
              if (!appType) continue;

              const ticketPattern = getTicketPattern(appType);
              const regex = new RegExp(ticketPattern.source, "g");

              for (const match of Array.from(text.matchAll(regex))) {
                const start = pos + match.index;
                const end = start + match[0].length;
                let ticketId = match[0];

                if (appType === "github" || appType === "gitlab") {
                  ticketId = ticketId.replace("#", "");
                }

                tr.addMark(
                  start,
                  end,
                  markType.create({
                    ticketId: match[0],
                    connectionUrl: connection.url,
                    connectionLabel: connection.label,
                    connectionId: connection.id,
                  }),
                );
                modified = true;
              }
            }
          });

          return modified ? tr : null;
        },
      }),
    ];
  },
});
