import { createEffect, createSignal, For } from "solid-js";
import { Dialog } from "./Dialog.tsx";
import { DialogFooter } from "./DialogFooter.tsx";

export interface ExcelExportConfig {
  sheetNameColumn: string;
  splitColumn: string;
  delimiter: string;
  parseBoldHeadings: boolean;
  summaryColumnCount: number;
}

interface Props {
  columns: string[];
  rowCount: number;
  onCancel?: () => void;
  onDownload?: (config: ExcelExportConfig) => void;
}

export function ExcelExportDialog(props: Props) {
  const [sheetNameColumn, setSheetNameColumn] = createSignal(props.columns[0] ?? "");
  const [splitColumn, setSplitColumn] = createSignal(
    props.columns[props.columns.length - 1] ?? "",
  );
  const [delimiter, setDelimiter] = createSignal("---");
  const [parseBoldHeadings, setParseBoldHeadings] = createSignal(true);
  const [summaryColumnCount, setSummaryColumnCount] = createSignal(
    Math.min(5, props.columns.length),
  );

  createEffect(() => {
    const cols = props.columns;
    if (!cols.includes(sheetNameColumn())) setSheetNameColumn(cols[0] ?? "");
    if (!cols.includes(splitColumn())) setSplitColumn(cols[cols.length - 1] ?? "");
  });

  function submit() {
    props.onDownload?.({
      sheetNameColumn: sheetNameColumn(),
      splitColumn: splitColumn(),
      delimiter: delimiter(),
      parseBoldHeadings: parseBoldHeadings(),
      summaryColumnCount: summaryColumnCount(),
    });
  }

  return (
    <Dialog
      show={true}
      title="Export to Excel"
      onUpdateShow={() => props.onCancel?.()}
      footer={
        <DialogFooter
          layout="end"
          confirmLabel="Download"
          disabled={!sheetNameColumn() || !splitColumn()}
          onCancel={() => props.onCancel?.()}
          onConfirm={submit}
        />
      }
    >
      <div class="flex flex-col gap-xs">
        <p class="text-neutral-500 text-size-small">
          Creates an Overview sheet plus one sub-sheet per row. Long cell content is split
          into rows by the delimiter.
        </p>

        <div class="flex flex-col gap-3xs">
          <label class="flex flex-col gap-4xs">
            <span class="font-medium text-neutral-700 text-size-small">
              Sheet name column
            </span>
            <span class="text-neutral-400 text-size-small">
              Column value used as the tab name for each sub-sheet
            </span>
            <select
              value={sheetNameColumn()}
              onChange={(e) => setSheetNameColumn(e.currentTarget.value)}
              class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-neutral-700 text-size-small focus:border-primary-400 focus:outline-none"
            >
              <For each={props.columns}>
                {(col) => <option value={col}>{col}</option>}
              </For>
            </select>
          </label>

          <label class="flex flex-col gap-4xs">
            <span class="font-medium text-neutral-700 text-size-small">Split column</span>
            <span class="text-neutral-400 text-size-small">
              Column whose content is split into rows within the sub-sheet
            </span>
            <select
              value={splitColumn()}
              onChange={(e) => setSplitColumn(e.currentTarget.value)}
              class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-neutral-700 text-size-small focus:border-primary-400 focus:outline-none"
            >
              <For each={props.columns}>
                {(col) => <option value={col}>{col}</option>}
              </For>
            </select>
          </label>

          <label class="flex flex-col gap-4xs">
            <span class="font-medium text-neutral-700 text-size-small">Delimiter</span>
            <span class="text-neutral-400 text-size-small">
              Split the content on this string (e.g.{" "}
              <code class="rounded-xs bg-neutral-100 px-1 font-mono">---</code>)
            </span>
            <input
              value={delimiter()}
              onInput={(e) => setDelimiter(e.currentTarget.value)}
              type="text"
              placeholder="---"
              class="rounded-sm border border-neutral-200 bg-background px-2 py-1 font-mono text-neutral-700 text-size-small focus:border-primary-400 focus:outline-none"
            />
          </label>

          <label class="flex cursor-pointer select-none items-center gap-2xs">
            <input
              checked={parseBoldHeadings()}
              onChange={(e) => setParseBoldHeadings(e.currentTarget.checked)}
              type="checkbox"
              class="rounded-xs accent-primary-600"
            />
            <span class="font-medium text-neutral-700 text-size-small">
              Parse{" "}
              <code class="rounded-xs bg-neutral-100 px-1 font-mono">
                **bold headings**
              </code>{" "}
              as columns
            </span>
          </label>

          <label class="flex flex-col gap-4xs">
            <span class="font-medium text-neutral-700 text-size-small">
              Summary columns
            </span>
            <span class="text-neutral-400 text-size-small">
              Number of leading columns included in the summary block above the split rows
            </span>
            <input
              value={summaryColumnCount()}
              onInput={(e) => setSummaryColumnCount(Number(e.currentTarget.value) || 0)}
              type="number"
              min="0"
              max={props.columns.length}
              class="rounded-sm border border-neutral-200 bg-background px-2 py-1 text-neutral-700 text-size-small focus:border-primary-400 focus:outline-none"
            />
          </label>
        </div>

        <p class="text-neutral-400 text-size-small">
          {props.rowCount} sub-sheet{props.rowCount === 1 ? "" : "s"} will be created (one
          per row in current filter).
        </p>
      </div>
    </Dialog>
  );
}

export default ExcelExportDialog;
