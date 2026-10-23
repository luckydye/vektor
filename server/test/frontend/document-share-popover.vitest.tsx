import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentSharePopover,
  type SharePopoverTrigger,
} from "#components/DocumentSharePopover.tsx";
import { renderWithLocale } from "./renderWithLocale.tsx";

vi.mock("#composeables/useSpace.ts", () => ({
  useSpace: () => ({
    currentSpaceId: () => "space_1",
    currentSpace: () => ({ id: "space_1", userRole: "owner", createdBy: "user_1" }),
  }),
}));

vi.mock("#composeables/useUserProfile.ts", () => ({
  useUserProfile: () => () => ({ id: "user_1" }),
}));

const documentAccessGet = vi.fn();
const shareLinksGet = vi.fn(async () => ({ links: [] }));

vi.mock("#api/client.ts", () => ({
  api: {
    documentAccess: { get: (...args: unknown[]) => documentAccessGet(...args) },
    shares: { get: (...args: unknown[]) => shareLinksGet(...args) },
    permissions: { list: async () => ({ permissions: [] }) },
    spaceMembers: { get: async () => [] },
    categories: { get: async () => ({ categories: [] }) },
  },
}));

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;
let trigger: SharePopoverTrigger | undefined;

afterEach(async () => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
  trigger = undefined;
  // The popover removes its body-level portal 150ms after it is hidden.
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (document.querySelector("a-popover-portal")) throw new Error("Popover portal leaked");
});

/** Mounted and opened, the way `DocumentActions` opens it through the trigger ref. */
function mount(documentId = "doc_1") {
  const [id, setId] = createSignal(documentId);
  host = document.createElement("div");
  document.body.append(host);
  dispose = renderWithLocale(
    () => (
      <DocumentSharePopover
        documentId={id()}
        canManageLinks={true}
        ref={(element) => {
          trigger = element;
        }}
      />
    ),
    host,
  );
  trigger?.show();
  return { setId };
}

function openLinkTab() {
  const tab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (button) => button.textContent?.trim() === "Share a link",
  );
  if (!tab) throw new Error("Share a link tab is missing");
  tab.click();
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function bodyText() {
  return document.body.textContent ?? "";
}

describe("DocumentSharePopover", () => {
  it("shows the failure instead of the empty state when a request rejects", async () => {
    documentAccessGet.mockRejectedValue(new Error("Forbidden"));
    mount();
    await settle();

    expect(bodyText()).not.toContain("No one has access to this document yet.");
    expect(bodyText()).toContain("Forbidden");
    expect(document.body.querySelector('[role="alert"]')).toBeTruthy();
  });

  it("offers a retry that reloads", async () => {
    documentAccessGet.mockRejectedValueOnce(new Error("Forbidden"));
    documentAccessGet.mockResolvedValue([]);
    mount();
    await settle();

    const retry = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    );
    expect(retry).toBeTruthy();
    retry?.click();
    await settle();

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(bodyText()).toContain("No one has access to this document yet.");
  });

  it("still shows the empty state when the load succeeds with no grants", async () => {
    documentAccessGet.mockResolvedValue([]);
    mount();
    await settle();

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(bodyText()).toContain("No one has access to this document yet.");
  });

  it("counts neither expired nor revoked links among the active ones", async () => {
    documentAccessGet.mockResolvedValue([]);
    const day = 24 * 60 * 60 * 1000;
    shareLinksGet.mockResolvedValue({
      links: [
        { id: "share_live", resourceType: "document", hasPassword: false },
        {
          id: "share_expired",
          resourceType: "document",
          hasPassword: false,
          expiresAt: new Date(Date.now() - day).toISOString(),
        },
        {
          id: "share_revoked",
          resourceType: "document",
          hasPassword: false,
          revokedAt: new Date(Date.now() - day).toISOString(),
        },
      ],
    });

    mount();
    await settle();
    openLinkTab();

    expect(bodyText()).toContain("1 active link");
  });

  it("does not show the previous page's links when reopened on another", async () => {
    documentAccessGet.mockResolvedValue([]);
    shareLinksGet.mockResolvedValue({
      links: [{ id: "share_first", resourceType: "document", hasPassword: false }],
    });

    const { setId } = mount("doc_1");
    await settle();
    openLinkTab();
    expect(bodyText()).toContain("1 active link");

    trigger?.hide();
    let release: (() => void) | undefined;
    shareLinksGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ links: [] });
        }),
    );
    setId("doc_2");
    trigger?.show();
    await settle();
    openLinkTab();

    expect(bodyText()).not.toContain("active link");
    release?.();
  });
});
