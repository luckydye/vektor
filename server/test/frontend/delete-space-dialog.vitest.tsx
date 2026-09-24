import { queryByText } from "@testing-library/dom";
import { createComponent, createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteSpaceDialog } from "#components/DeleteSpaceDialog.tsx";

/**
 * One dialog behind both the space's own settings and the spaces overview. The
 * contract either way: nothing is deleted until the slug is typed out, and a
 * rejection keeps the dialog open with the reason.
 */

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

type Props = Record<string, unknown>;

const SPACE = { id: "s1", name: "Engineering", slug: "engineering" };

function mount(props: Props) {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(
    () => createComponent(DeleteSpaceDialog as (props: Props) => JSX.Element, props),
    container,
  );
  disposers.push(() => {
    unmount();
    container.remove();
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function type(value: string) {
  const input = document.body.querySelector<HTMLInputElement>("#delete-space-slug");
  if (!input) throw new Error("no slug input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The footer's confirm button, which the dialog title's text also matches. */
function confirmButton() {
  return document.body.querySelector<HTMLButtonElement>(
    'button[form="delete-space-form"]',
  );
}

async function submit() {
  const form = document.body.querySelector<HTMLFormElement>("#delete-space-form");
  if (!form) throw new Error("no form");
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await settle();
}

describe("DeleteSpaceDialog", () => {
  it("keeps confirmation disabled until the slug matches", async () => {
    mount({ space: SPACE, onConfirm: vi.fn() });
    await settle();

    expect(confirmButton()?.disabled).toBe(true);

    type("engineer");
    expect(confirmButton()?.disabled).toBe(true);

    type("engineering");
    expect(confirmButton()?.disabled).toBe(false);
  });

  it("deletes nothing while the typed slug is wrong", async () => {
    const onConfirm = vi.fn();
    mount({ space: SPACE, onConfirm });
    await settle();

    type("Engineering");
    await submit();

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("deletes the space once the slug is typed out", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    mount({ space: SPACE, onConfirm });
    await settle();

    type("engineering");
    await submit();

    expect(onConfirm).toHaveBeenCalledWith("s1");
  });

  it("stays open with the reason when the delete fails", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("Space is not empty"));
    const onCancel = vi.fn();
    mount({ space: SPACE, onConfirm, onCancel });
    await settle();

    type("engineering");
    await submit();

    expect(queryByText(document.body, "Space is not empty")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("clears what was typed when a different space is picked", async () => {
    const [current, setCurrent] = createSignal(SPACE);
    mount({
      get space() {
        return current();
      },
      onConfirm: vi.fn(),
    });
    await settle();

    type("engineering");
    expect(confirmButton()?.disabled).toBe(false);

    setCurrent({ id: "s2", name: "Design", slug: "design" });
    await settle();

    expect(
      document.body.querySelector<HTMLInputElement>("#delete-space-slug")?.value,
    ).toBe("");
    expect(confirmButton()?.disabled).toBe(true);
  });
});
