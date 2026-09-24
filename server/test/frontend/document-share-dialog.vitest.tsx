import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentShareDialog } from "#components/DocumentShareDialog.tsx";

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

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <DocumentShareDialog show={true} documentId="doc_1" />, host);
}

function mountControlled(documentId: string) {
  const [show, setShow] = createSignal(true);
  const [id, setId] = createSignal(documentId);
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <DocumentShareDialog show={show()} documentId={id()} />, host);
  return { setShow, setId };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function bodyText() {
  return document.body.textContent ?? "";
}

describe("DocumentShareDialog", () => {
  it("shows the failure instead of the empty state when a request rejects", async () => {
    documentAccessGet.mockRejectedValue(new Error("Forbidden"));
    mount();
    await settle();

    expect(bodyText()).not.toContain("No one has access to this page yet.");
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
    expect(bodyText()).toContain("No one has access to this page yet.");
  });

  it("still shows the empty state when the load succeeds with no grants", async () => {
    documentAccessGet.mockResolvedValue([]);
    mount();
    await settle();

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(bodyText()).toContain("No one has access to this page yet.");
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

    expect(bodyText()).toContain("1 active link");
  });

  it("does not show the previous page's links when reopened on another", async () => {
    documentAccessGet.mockResolvedValue([]);
    shareLinksGet.mockResolvedValue({
      links: [{ id: "share_first", resourceType: "document", hasPassword: false }],
    });

    const { setShow, setId } = mountControlled("doc_1");
    await settle();
    expect(bodyText()).toContain("1 active link");

    setShow(false);
    let release: (() => void) | undefined;
    shareLinksGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ links: [] });
        }),
    );
    setId("doc_2");
    setShow(true);
    await settle();

    expect(bodyText()).not.toContain("active link");
    release?.();
  });
});
