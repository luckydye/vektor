import { queryByText } from "@testing-library/dom";
import { createComponent, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateSpaceDialog } from "#components/CreateSpaceDialog.tsx";

/**
 * The dialog only learns that a create failed by awaiting `onCreate` — the
 * server rejects a taken slug, and closing on a rejection looks exactly like
 * success from the outside. So the contract under test is: close on resolve,
 * stay open and show the message on reject.
 */

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

type Props = Record<string, unknown>;

function mount(props: Props) {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(
    () => createComponent(CreateSpaceDialog as (props: Props) => JSX.Element, props),
    container,
  );
  disposers.push(() => {
    unmount();
    container.remove();
  });
}

/** Dialog mounts through ClientOnly, which renders on mount rather than immediately. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fill(id: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no #${id}`);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit() {
  const form = document.body.querySelector<HTMLFormElement>("#create-space-form");
  if (!form) throw new Error("no form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

describe("CreateSpaceDialog", () => {
  it("keeps the dialog open and shows the error when creating fails", async () => {
    const onUpdateShow = vi.fn();
    const onCreate = vi
      .fn()
      .mockRejectedValue(new Error('Space with slug "trav-space" already exists'));
    mount({ show: true, onUpdateShow, onCreate });
    await settle();

    fill("space-name", "Trav Space");
    await submit();

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Trav Space", slug: "trav-space" }),
    );
    expect(onUpdateShow).not.toHaveBeenCalled();
    expect(
      queryByText(document.body, 'Space with slug "trav-space" already exists'),
    ).toBeTruthy();
    // The typed name survives so the slug can be corrected in place.
    expect(document.body.querySelector<HTMLInputElement>("#space-name")?.value).toBe(
      "Trav Space",
    );
  });

  it("closes once the create resolves", async () => {
    const onUpdateShow = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    mount({ show: true, onUpdateShow, onCreate });
    await settle();

    fill("space-name", "Fresh Space");
    await submit();

    expect(onCreate).toHaveBeenCalled();
    expect(onUpdateShow).toHaveBeenCalledWith(false);
  });

  it("rejects a bad slug before calling onCreate", async () => {
    const onCreate = vi.fn();
    mount({ show: true, onCreate });
    await settle();

    fill("space-name", "Trav Space");
    fill("space-slug", "Not A Slug");
    await submit();

    expect(onCreate).not.toHaveBeenCalled();
    expect(
      queryByText(
        document.body,
        "Slug must contain only lowercase letters, numbers, and hyphens",
      ),
    ).toBeTruthy();
  });
});
