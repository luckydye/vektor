/**
 * The formatting toolbar.
 *
 * Every control writes through the engine's `updateRangeStyle` (or
 * `setAreaWithBorder`) onto the selected range, and reads its own on/off state
 * back from the style of the selected cell. There is no local state to keep in
 * step — the model is the state, and `revision` is what makes reading it
 * reactive.
 *
 * All of it survives a reload: `#spreadsheet/csvDocument.ts` stores each cell's
 * style alongside its value. A control that could not be saved is not here.
 */

import type {
  BorderType,
  Color,
  HorizontalAlignment,
  Model,
  VerticalAlignment,
} from "@ironcalc/wasm";
import { For } from "solid-js";
import {
  alignBottomIcon,
  alignMiddleIcon,
  alignTopIcon,
  boldIcon,
  cellFillIcon,
  clearFormatIcon,
  gridGridIcon,
  italicIcon,
  justifyCenterIcon,
  justifyLeftIcon,
  justifyRightIcon,
  redoIcon,
  strikeThroughIcon,
  textColorIcon,
  underlineIcon,
  undoIcon,
  wrapTextIcon,
} from "#assets/icons.ts";
import { Icon } from "#components/Icon.tsx";
import { Popover } from "#spreadsheet/Popover.tsx";
import { t } from "#utils/lang.ts";

interface Props {
  model: Model;
  canEdit: boolean;
  revision: () => number;
  /** Applies an engine call and marks the document dirty. */
  apply: (action: () => void) => void;
  /** Hands the keyboard back to the grid after a control is used. */
  focusGrid: () => void;
}

/** Number formats offered by the menu, in the order they appear. */
const NUMBER_FORMATS: { label: string; format: string; sample: string }[] = [
  { label: "Automatic", format: "general", sample: "1234.56" },
  { label: "Plain number", format: "#,##0.00", sample: "1,234.56" },
  { label: "Percent", format: "0.00%", sample: "12.34%" },
  { label: "Euro", format: '"€"#,##0.00', sample: "€1,234.56" },
  { label: "US dollar", format: '"$"#,##0.00', sample: "$1,234.56" },
  { label: "Pound", format: '"£"#,##0.00', sample: "£1,234.56" },
  { label: "Date", format: "dd/mm/yyyy", sample: "31/12/2026" },
];

/**
 * The palette the colour pickers offer. Deliberately a fixed set rather than a
 * full colour wheel: these are cell colours, and a short list of legible ones
 * keeps a sheet looking deliberate.
 */
const PALETTE: string[] = [
  "#000000",
  "#3D3D3D",
  "#6E6E6E",
  "#B0B0B0",
  "#E8E8E8",
  "#FFFFFF",
  "#D03627",
  "#EC5753",
  "#F2994A",
  "#F8CD3C",
  "#3BB68A",
  "#59B9BC",
  "#3358B7",
  "#523E93",
  "#A23C52",
  "#8CB354",
  "#1B717E",
  "#8CA0B3",
];

const BORDERS: { label: string; border: BorderType }[] = [
  { label: "All", border: "All" as BorderType },
  { label: "Outer", border: "Outer" as BorderType },
  { label: "Inner", border: "Inner" as BorderType },
  { label: "Top", border: "Top" as BorderType },
  { label: "Right", border: "Right" as BorderType },
  { label: "Bottom", border: "Bottom" as BorderType },
  { label: "Left", border: "Left" as BorderType },
  { label: "None", border: "None" as BorderType },
];

/**
 * `updateRangeStyle` wants a colour as a string: a hex value, or `""` to clear
 * it back to the default.
 */
function colorToParam(color: Color): string {
  if (color === undefined) return "";
  return typeof color === "string" ? color : `[${color[0]}, ${color[1]}]`;
}

/** Upstream's decimal stepping, which is a string edit on the format itself. */
function withMoreDecimals(format: string): string {
  if (format === "general") return "#,##0.000";
  const widened = format.replace(/\.0/g, ".00");
  if (widened.includes(".")) return widened;
  if (widened.includes("0")) return widened.replace(/0/g, "0.0");
  if (widened.includes("#")) return widened.replace(/#([^#,]|$)/g, "0.0$1");
  return format;
}

function withFewerDecimals(format: string): string {
  if (format === "general") return "#,##0.0";
  return format.replace(/\.0/g, ".").replace(/0\.([^0]|$)/, "0$1");
}

export function Toolbar(props: Props) {
  /** The style of the selected cell, which is what the controls reflect. */
  const style = () => {
    props.revision();
    const { sheet, row, column } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
    return props.model.getCellStyle(sheet, row, column).style;
  };

  const selectedArea = () => {
    const {
      sheet,
      range: [rowStart, columnStart, rowEnd, columnEnd],
    } = props.model.getSelectedView();
    return {
      sheet,
      row: Math.min(rowStart, rowEnd),
      column: Math.min(columnStart, columnEnd),
      width: Math.abs(columnEnd - columnStart) + 1,
      height: Math.abs(rowEnd - rowStart) + 1,
    };
  };

  const setStyle = (path: string, value: string) => {
    props.apply(() => props.model.updateRangeStyle(selectedArea(), path, value));
    props.focusGrid();
  };

  const canUndo = () => {
    props.revision();
    return props.model.canUndo();
  };
  const canRedo = () => {
    props.revision();
    return props.model.canRedo();
  };

  const fontSize = () => Math.round(style().font.sz);
  const numberFormat = () => style().num_fmt;

  return (
    <div class="ic-toolbar">
      <button
        type="button"
        disabled={!props.canEdit || !canUndo()}
        title={t("Undo")}
        onClick={() => {
          props.apply(() => props.model.undo());
          props.focusGrid();
        }}
      >
        <Icon svg={undoIcon} />
      </button>
      <button
        type="button"
        disabled={!props.canEdit || !canRedo()}
        title={t("Redo")}
        onClick={() => {
          props.apply(() => props.model.redo());
          props.focusGrid();
        }}
      >
        <Icon svg={redoIcon} />
      </button>

      <span class="ic-toolbar-divider" />

      <button
        type="button"
        disabled={!props.canEdit}
        title={t("Clear formatting")}
        onClick={() => {
          const { sheet, row, column, width, height } = selectedArea();
          props.apply(() =>
            props.model.rangeClearFormatting(
              sheet,
              row,
              column,
              row + height - 1,
              column + width - 1,
            ),
          );
          props.focusGrid();
        }}
      >
        <Icon svg={clearFormatIcon} />
      </button>

      <span class="ic-toolbar-divider" />

      <button
        type="button"
        class="ic-toolbar-glyph"
        disabled={!props.canEdit}
        title={t("Format as currency")}
        onClick={() => setStyle("num_fmt", '"€"#,##0.00')}
      >
        €
      </button>
      <button
        type="button"
        class="ic-toolbar-glyph"
        disabled={!props.canEdit}
        title={t("Format as percent")}
        onClick={() => setStyle("num_fmt", "0.00%")}
      >
        %
      </button>
      <button
        type="button"
        class="ic-toolbar-glyph ic-toolbar-glyph--small"
        disabled={!props.canEdit}
        title={t("Decrease decimal places")}
        onClick={() => setStyle("num_fmt", withFewerDecimals(numberFormat()))}
      >
        .0
      </button>
      <button
        type="button"
        class="ic-toolbar-glyph ic-toolbar-glyph--small"
        disabled={!props.canEdit}
        title={t("Increase decimal places")}
        onClick={() => setStyle("num_fmt", withMoreDecimals(numberFormat()))}
      >
        .00
      </button>

      <Popover
        class="ic-menu--wide"
        trigger={(toggle) => (
          <button
            type="button"
            class="ic-toolbar-glyph ic-toolbar-glyph--wide"
            disabled={!props.canEdit}
            title={t("Number format")}
            onClick={toggle}
          >
            123 <span class="ic-caret" />
          </button>
        )}
      >
        {(close) => (
          <ul>
            <For each={NUMBER_FORMATS}>
              {(entry) => (
                <li>
                  <button
                    type="button"
                    classList={{
                      "ic-menu-item--active": numberFormat() === entry.format,
                    }}
                    onClick={() => {
                      setStyle("num_fmt", entry.format);
                      close();
                    }}
                  >
                    <span>{t(entry.label)}</span>
                    <span class="ic-menu-sample">{entry.sample}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        )}
      </Popover>

      <span class="ic-toolbar-divider" />

      <button
        type="button"
        class="ic-toolbar-glyph"
        disabled={!props.canEdit}
        title={t("Decrease font size")}
        onClick={() => setStyle("font.size_delta", "-1")}
      >
        −
      </button>
      <span class="ic-font-size">{fontSize()}</span>
      <button
        type="button"
        class="ic-toolbar-glyph"
        disabled={!props.canEdit}
        title={t("Increase font size")}
        onClick={() => setStyle("font.size_delta", "1")}
      >
        +
      </button>

      <span class="ic-toolbar-divider" />

      <button
        type="button"
        classList={{ "ic-toolbar-button--active": style().font.b }}
        disabled={!props.canEdit}
        title={t("Bold")}
        onClick={() => setStyle("font.b", `${!style().font.b}`)}
      >
        <Icon svg={boldIcon} />
      </button>
      <button
        type="button"
        classList={{ "ic-toolbar-button--active": style().font.i }}
        disabled={!props.canEdit}
        title={t("Italic")}
        onClick={() => setStyle("font.i", `${!style().font.i}`)}
      >
        <Icon svg={italicIcon} />
      </button>
      <button
        type="button"
        classList={{ "ic-toolbar-button--active": style().font.u }}
        disabled={!props.canEdit}
        title={t("Underline")}
        onClick={() => setStyle("font.u", `${!style().font.u}`)}
      >
        <Icon svg={underlineIcon} />
      </button>
      <button
        type="button"
        classList={{ "ic-toolbar-button--active": style().font.strike }}
        disabled={!props.canEdit}
        title={t("Strikethrough")}
        onClick={() => setStyle("font.strike", `${!style().font.strike}`)}
      >
        <Icon svg={strikeThroughIcon} />
      </button>

      <span class="ic-toolbar-divider" />

      <ColorControl
        title={t("Text colour")}
        icon={textColorIcon}
        current={style().font.color}
        canEdit={props.canEdit}
        onPick={(color) => setStyle("font.color", colorToParam(color))}
      />
      <ColorControl
        title={t("Fill colour")}
        icon={cellFillIcon}
        current={style().fill.color}
        canEdit={props.canEdit}
        onPick={(color) => setStyle("fill.color", colorToParam(color))}
      />

      <Popover
        trigger={(toggle) => (
          <button
            type="button"
            disabled={!props.canEdit}
            title={t("Borders")}
            onClick={toggle}
          >
            <Icon svg={gridGridIcon} />
          </button>
        )}
      >
        {(close) => (
          <ul>
            <For each={BORDERS}>
              {(entry) => (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      props.apply(() =>
                        props.model.setAreaWithBorder(selectedArea(), {
                          item: { style: "thin" as never, color: "#B0B0B0" },
                          type: entry.border,
                        }),
                      );
                      props.focusGrid();
                      close();
                    }}
                  >
                    {t(entry.label)}
                  </button>
                </li>
              )}
            </For>
          </ul>
        )}
      </Popover>

      <span class="ic-toolbar-divider" />

      <AlignControl
        canEdit={props.canEdit}
        options={[
          { value: "left", icon: justifyLeftIcon, title: t("Align left") },
          { value: "center", icon: justifyCenterIcon, title: t("Align centre") },
          { value: "right", icon: justifyRightIcon, title: t("Align right") },
        ]}
        current={style().alignment?.horizontal}
        onPick={(value) => setStyle("alignment.horizontal", value)}
      />
      <AlignControl
        canEdit={props.canEdit}
        options={[
          { value: "top", icon: alignTopIcon, title: t("Align top") },
          { value: "center", icon: alignMiddleIcon, title: t("Align middle") },
          { value: "bottom", icon: alignBottomIcon, title: t("Align bottom") },
        ]}
        current={style().alignment?.vertical}
        onPick={(value) => setStyle("alignment.vertical", value)}
      />
      <button
        type="button"
        classList={{ "ic-toolbar-button--active": style().alignment?.wrap_text }}
        disabled={!props.canEdit}
        title={t("Wrap text")}
        onClick={() =>
          setStyle("alignment.wrap_text", `${!style().alignment?.wrap_text}`)
        }
      >
        <Icon svg={wrapTextIcon} />
      </button>
    </div>
  );
}

/** A colour swatch that opens the palette. */
function ColorControl(props: {
  title: string;
  icon: string;
  current: Color;
  canEdit: boolean;
  onPick: (color: Color) => void;
}) {
  return (
    <Popover
      class="ic-menu--palette"
      trigger={(toggle) => (
        <button
          type="button"
          disabled={!props.canEdit}
          title={props.title}
          onClick={toggle}
        >
          <span class="ic-color-button">
            <Icon svg={props.icon} />
            <span
              class="ic-color-swatch"
              style={{
                background:
                  typeof props.current === "string" ? props.current : "transparent",
              }}
            />
          </span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div class="ic-palette">
            <For each={PALETTE}>
              {(color) => (
                <button
                  type="button"
                  class="ic-swatch"
                  style={{ background: color }}
                  title={color}
                  onClick={() => {
                    props.onPick(color);
                    close();
                  }}
                />
              )}
            </For>
          </div>
          <button
            type="button"
            class="ic-palette-reset"
            onClick={() => {
              props.onPick(undefined);
              close();
            }}
          >
            {t("Reset")}
          </button>
        </>
      )}
    </Popover>
  );
}

/** A run of mutually exclusive alignment buttons. */
function AlignControl<T extends HorizontalAlignment | VerticalAlignment>(props: {
  canEdit: boolean;
  options: { value: T; icon: string; title: string }[];
  current: T | undefined;
  onPick: (value: T) => void;
}) {
  return (
    <>
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            classList={{ "ic-toolbar-button--active": props.current === option.value }}
            disabled={!props.canEdit}
            title={option.title}
            onClick={() => props.onPick(option.value)}
          >
            <Icon svg={option.icon} />
          </button>
        )}
      </For>
    </>
  );
}
