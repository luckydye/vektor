import { detectAppType } from "~/src/utils/utils.ts";

function getTicketUrlTemplate(
  appType: "jira" | "youtrack" | "linear" | "github" | "gitlab",
  baseUrl: string,
): string {
  if (!baseUrl) {
    return "";
  }

  const cleanUrl = baseUrl.replace(/\/$/, "");

  switch (appType) {
    case "jira":
      return `${cleanUrl}/browse/{ticketId}`;
    case "youtrack":
      return `${cleanUrl}/issue/{ticketId}`;
    case "linear":
      return `${cleanUrl}/issue/{ticketId}`;
    case "github":
      return `${cleanUrl}/issues/{ticketId}`;
    case "gitlab":
      return `${cleanUrl}/-/issues/{ticketId}`;
    default:
      return `${cleanUrl}/{ticketId}`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ticket-link")) {
  customElements.define(
    "ticket-link",
    class extends HTMLElement {
      constructor() {
        super();

        this.addEventListener("click", this.click);
        this.addEventListener("auxclick", this.click);
      }

      click() {
        const connectionLabel = this.getAttribute("data-connection-label");
        if (!connectionLabel) {
          throw new Error("No connection label");
        }

        const appType = detectAppType(connectionLabel);
        if (!appType) {
          throw new Error("Missing valid appType");
        }

        const ticketId = this.getAttribute("data-ticket-id");
        if (!ticketId) {
          throw new Error("Missing ticketId");
        }

        const connectionUrl = this.getAttribute("data-connection-url");
        if (!connectionUrl) {
          throw new Error("Missing connectionUrl");
        }

        const baseUrl = new URL(connectionUrl).origin;
        const urlTemplate = getTicketUrlTemplate(appType, baseUrl);
        const ticketUrl = urlTemplate.replace("{ticketId}", ticketId);
        window.open(ticketUrl, "_blank");
      }
    },
  );
}
