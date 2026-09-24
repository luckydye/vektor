import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "#components/DataTable.tsx";

/**
 * The Excel export chain, which nothing else covers.
 *
 * `test/xlsx.spec.ts` proves the workbook bytes are right, and the visual
 * suite never reaches this UI — it only renders inside a workflow run's
 * results. What is left unverified in between is the wiring: the toolbar button opening the dialog, and the dialog's confirm
 * reaching `downloadExcelSheets` with the configured columns.
 */

const ROWS = [
  { Project: "Apollo", Owner: "ada", Status: "GREEN" },
  { Project: "Gemini", Owner: "bob", Status: "ROT" },
];

const open: Array<() => void> = [];
afterEach(() => {
  for (const dispose of open.splice(0)) dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  open.push(
    render(() => <DataTable data={ROWS} exportFileName="runs.xlsx" />, container),
  );
  return container;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("excel export", () => {
  it("opens the dialog from the toolbar and downloads the configured sheets", async () => {
    // The object URL is the seam: it carries the finished workbook. Only that
    // one method is replaced — swapping the whole `URL` global breaks
    // happy-dom's own `new URL(...)`. The anchor click is stubbed because
    // happy-dom treats a `download` navigation as a real one.
    Object.assign(URL, { createObjectURL: () => "", revokeObjectURL: () => {} });
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fixture");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const container = mount();
    await settle();

    const toolbarButton = container.querySelector<HTMLButtonElement>(
      'button[title="Download as Excel"]',
    );
    expect(toolbarButton).toBeTruthy();

    toolbarButton?.click();
    await settle();

    const confirm = [...document.querySelectorAll("button")].find((button) =>
      /download/i.test(button.textContent ?? ""),
    );
    expect(confirm, "export dialog should offer a download").toBeTruthy();

    confirm?.click();
    await settle();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob.size).toBeGreaterThan(0);
  });
});
