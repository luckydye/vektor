# The spreadsheet grid renderer

Ported from [IronCalc](https://github.com/ironcalc/ironcalc) at tag **v0.8.3**,
`webapp/IronCalc/src/`. MIT OR Apache-2.0, which vektor's AGPL-3.0 can absorb;
the copyright notice stays on each ported file.

We use IronCalc's engine (`@ironcalc/wasm`, pinned to **0.8.4** — 0.8.3 and
earlier ship a broken tarball that omits the `snippets/` directory `wasm.js`
imports; 0.8.4's method surface is identical to the v0.8.3 tag this was ported
from). We do **not** use `@ironcalc/workbook`, its UI, because that is React and
vektor is Solid.

The split makes that cheap: everything here is framework-free TypeScript that
draws to a `<canvas>` and a handful of `<div>`s. Only upstream's thin wrappers
were React, and those are rewritten in Solid one directory up.

| File | Upstream path |
| --- | --- |
| `worksheetCanvas.ts` | `components/WorksheetCanvas/worksheetCanvas.ts` |
| `canvasUtil.ts` | `components/WorksheetCanvas/util.ts` |
| `constants.ts` | `components/WorksheetCanvas/constants.ts` |
| `cfRenderer.ts` | `components/WorksheetCanvas/cfRenderer.ts` |
| `lucideIconPaths.ts` | `components/WorksheetCanvas/lucideIconPaths.ts` |
| `outlineHandle.ts` | `components/WorksheetCanvas/outlineHandle.ts` |
| `workbookState.ts` | `components/workbookState.ts` |
| `types.ts` | `components/types.ts` |
| `address.ts` | `components/util.ts` |
| `colors.ts` | `getColor` from `components/Editor/util.tsx` |

## What we changed

Everything sits in one flat directory, so the imports were rewritten and two
files renamed (`util.ts` collides twice upstream). Beyond that:

- **`devicePixelRatio` is read per render**, not once at import. The module is
  reachable during SSR, where there is no `window`.
- **`colors.ts`** drops the unused `name` fields, and fixes an upstream
  copy-paste: "Wasabi" carried Burgundy's `rgba` while its `hex` said otherwise,
  so a translucent Wasabi range came out the wrong colour.
- **`onContentChanged`**, a callback added alongside upstream's `refresh`.
  Upstream redraws and saves on the same signal; here saving is a document
  write, so the two had to be told apart — otherwise selecting a cell rewrote
  the document. `refresh` repaints; `onContentChanged` fires only where cells
  actually change, which in the ported code means the two autofill paths in
  `outlineHandle.ts` and the commit-on-click-away in `../pointer.ts`.
- **`getAreaDimensions` is public**, so the presence overlays can size a
  peer's selection the same way the selection outline is sized.
- **Two performance fixes** carried over from `~/source/sheets/patches/`, neither
  of which is fixed upstream in 0.8.3. They were written against v0.7.1 and no
  longer apply as patches, so they are re-implemented here:

  **Pixel-smooth scrolling.** The model stores only the top-left visible *cell*,
  so the grid jumped a whole row or column per scroll event — very noticeable
  horizontally, where columns are wide. `WorksheetCanvas.scrollOffset` keeps the
  leftover pixels as a sub-cell offset (owned by the caller, so it survives the
  canvas being recreated) and shifts cell rendering, headers and hit-testing by
  it. Panes and outlines are clipped, which they had to be anyway once a row or
  column can be partially scrolled.

  **Bounded text wrapping.** Wrapping measures a cell word by word, so a cell
  holding a few thousand characters costs thousands of `measureText` calls — and
  the grid re-wrapped every visible cell on every scroll event. Three changes:
  wrapped lines and their widths are cached and reused across scroll frames
  (only a scroll may reuse them; any other render may follow an edit); text
  hanging from the top of a cell stops wrapping once the cell is full; and a
  line is measured whole before being wrapped word by word, but only its first
  512 characters — enough to know a very long one does not fit.

  One rendering difference, worth knowing about: when a cell contains a line
  wider than the column *below* what fits in it — a long unbroken URL, say —
  upstream used that invisible line to suppress the neighbouring cell's left
  border. With wrapping now bounded, that 1px gridline is drawn. Dropping the
  `lineBudget` in `computeCellText` (always `POSITIVE_INFINITY`) restores
  upstream's output exactly, at the cost of a stall whenever a text-heavy cell
  first scrolls into view.

## Re-porting

There is no patch series to re-apply — the upstream files were copied in and
edited. To move to a newer IronCalc, diff the new tag's files against v0.8.3,
apply what changed here by hand, and keep the changes above.
