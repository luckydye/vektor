import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentShareDialog } from "#components/DocumentShareDialog.tsx";

/**
 * The share dialog's lists are access-control statements, so a failed load must
 * never render as "no one has access" — that is the opposite of the truth, and
 * it used to be what a single rejected request produced.
 */

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

vi.mock("#api/client.ts", () => ({
  api: {
    documentAccess: { get: (...args: unknown[]) => documentAccessGet(...args) },
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

/** The dialog runs its three loads in parallel when it opens. */
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
});
