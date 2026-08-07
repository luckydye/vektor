// Ported from IronCalc `components/WorksheetCanvas/util.ts` at tag v0.8.3, MIT OR Apache-2.0.
// See ./README.md for what was changed and why.

// Get a 10% transparency of an hex color
export function hexToRGBA10Percent(colorHex: string): string {
  // Remove the leading hash (#) if present
  const hex = colorHex.replace(/^#/, "");

  // Parse the hex color
  const red = Number.parseInt(hex.substring(0, 2), 16);
  const green = Number.parseInt(hex.substring(2, 4), 16);
  const blue = Number.parseInt(hex.substring(4, 6), 16);

  // Set the alpha (opacity) to 0.1 (10%)
  const alpha = 0.1;

  // Return the RGBA color string
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * No column is wide enough to fit this many characters, so this is how much of a
 * line has to be measured to know that the whole of it does not fit.
 */
const PROBE_LENGTH = 512;

/**
 * Splits the given text into multiple lines. If `wrapText` is true, it applies word-wrapping
 * based on the specified canvas context, maximum width, and horizontal padding.
 *
 * - First, the text is split by newline characters so that explicit newlines are respected.
 * - If wrapping is enabled, each line is further split into words and measured against the
 *   available width. Whenever adding an extra word would exceed
 *   this limit, a new line is started.
 *
 * @param text     The text to split into lines.
 * @param wrapText Whether to apply word-wrapping or just return text split by newlines.
 * @param context  The `CanvasRenderingContext2D` used for measuring text width.
 * @param width    The maximum width for each line.
 * @param maxLines Stop after this many lines. Wrapping measures every word, so a
 *                 cell holding thousands of characters is expensive; the caller
 *                 passes a limit when it knows the rest would be clipped away.
 * @returns        An array of lines (strings), each fitting within the specified width if wrapping is enabled.
 */
export function computeWrappedLines(
  text: string,
  wrapText: boolean,
  context: CanvasRenderingContext2D,
  width: number,
  maxLines = Number.POSITIVE_INFINITY,
): string[] {
  // Split the text into lines
  const rawLines = text.split("\n");
  if (!wrapText) {
    // If there is no wrapping, return the raw lines
    return rawLines;
  }
  const wrappedLines: string[] = [];
  for (const line of rawLines) {
    if (wrappedLines.length >= maxLines) {
      return wrappedLines;
    }
    // A line that fits as it is needs no wrapping. Worth a look before measuring
    // it word by word, which costs a measurement per word.
    // Only the start of the line is measured: measuring a very long string is
    // slow in itself, and if its first characters are already too wide for the
    // cell then so is the whole thing.
    const probe = line.length > PROBE_LENGTH ? line.slice(0, PROBE_LENGTH) : line;
    if (context.measureText(probe).width < width && probe.length === line.length) {
      wrappedLines.push(line);
      continue;
    }
    const words = line.split(" ");
    let currentLine = words[0] as string;
    let truncated = false;
    for (let i = 1; i < words.length; i += 1) {
      const word = words[i];
      const testLine = `${currentLine} ${word}`;
      const textWidth = context.measureText(testLine).width;
      if (textWidth < width) {
        currentLine = testLine;
      } else {
        wrappedLines.push(currentLine);
        if (wrappedLines.length >= maxLines) {
          truncated = true;
          break;
        }
        currentLine = word as string;
      }
    }
    if (!truncated) {
      wrappedLines.push(currentLine);
    }
  }
  return wrappedLines;
}

function readCSSVar(name: string, style: CSSStyleDeclaration): string {
  return style.getPropertyValue(name).trim();
}

export function readThemeFromCSS(root: Element): Theme {
  const style = getComputedStyle(root);
  return {
    backgroundColor: readCSSVar("--palette-common-white", style),
    commonWhite: readCSSVar("--palette-common-white", style),
    gridColor: readCSSVar("--palette-sheet-grid-color", style),
    cellFontFamily: readCSSVar("--palette-sheet-default-cell-font-family", style),
    primaryMain: readCSSVar("--palette-primary-main", style),
    headerTextColor: readCSSVar("--palette-sheet-header-text-color", style),
    headerBackground: readCSSVar("--palette-sheet-header-background", style),
    headerSelectedBackground: readCSSVar(
      "--palette-sheet-header-selected-background",
      style,
    ),
    headerBorderColor: readCSSVar("--palette-sheet-header-border-color", style),
    outlineColor: readCSSVar("--palette-sheet-outline-color", style),
    headerFont: readCSSVar("--palette-sheet-header-font", style),
    gridSeparatorColor: readCSSVar("--palette-sheet-grid-separator-color", style),
    defaultTextColor: readCSSVar("--palette-sheet-default-text-color", style),
    headerSelectedColor: readCSSVar("--palette-sheet-header-selected-color", style),
  };
}

export interface Theme {
  backgroundColor: string;
  gridColor: string;
  cellFontFamily: string;
  primaryMain: string;
  headerTextColor: string;
  headerBackground: string;
  headerSelectedBackground: string;
  headerBorderColor: string;
  outlineColor: string;
  headerFont: string;
  gridSeparatorColor: string;
  defaultTextColor: string;
  commonWhite: string;
  headerSelectedColor: string;
}
