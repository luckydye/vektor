/**
 * Mounts the spreadsheet inside a shadow root.
 *
 * The grid renderer sizes the selection outline, the resize guides and every
 * column header itself, in pixels, assuming the CSS box model it was written
 * against. The app's Tailwind reset sets `box-sizing: border-box` on every
 * element, so each of those came out short by its own border and the overlays
 * drifted off the cells they were tracking. A shadow root is the reliable fix:
 * page styles do not cross into it at all, so the grid's geometry is its own.
 *
 * Design tokens still reach the grid — custom properties inherit through a
 * shadow boundary — so the app's theme and the space's brand colour apply as
 * before. What does not cross is the reset, which is the point.
 */

import type { Model } from "@ironcalc/wasm";
import { onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import type { RemoteSelection, SheetSelection } from "#spreadsheet/presence.ts";
import { Spreadsheet } from "#spreadsheet/Spreadsheet.tsx";
import styles from "#spreadsheet/spreadsheet.css?inline";

interface Props {
  model: Model;
  canEdit: boolean;
  onChange: () => void;
  /** Bumped when a peer's edit has been applied to the model; repaint. */
  remoteRevision: () => number;
  remoteSelections: () => RemoteSelection[];
  onSelectionChange: (selection: SheetSelection) => void;
}

/**
 * Parsed once and shared by every spreadsheet on the page. Falls back to a
 * `<style>` element where constructable stylesheets are unavailable.
 */
let sheet: CSSStyleSheet | undefined;

function adoptStyles(shadow: ShadowRoot): void {
  if (typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype) {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(styles);
    }
    shadow.adoptedStyleSheets = [sheet];
    return;
  }
  const element = document.createElement("style");
  element.textContent = styles;
  shadow.append(element);
}

export function SpreadsheetHost(props: Props) {
  let host!: HTMLDivElement;

  onMount(() => {
    const shadow = host.attachShadow({ mode: "open" });
    adoptStyles(shadow);
    const dispose = render(
      () => (
        <Spreadsheet
          model={props.model}
          canEdit={props.canEdit}
          onChange={props.onChange}
          remoteRevision={props.remoteRevision}
          remoteSelections={props.remoteSelections}
          onSelectionChange={props.onSelectionChange}
          // Focus and the context menu need to ask *this* root what is focused
          // and where a click landed; `document.activeElement` and `event.target`
          // both stop at the host once a shadow boundary is in the way.
          shadowRoot={shadow}
        />
      ),
      shadow,
    );
    onCleanup(dispose);
  });

  // A definite height on the host is what lets `.ic-root { height: 100% }`
  // resolve inside the shadow root.
  return <div class="flex min-h-0 flex-1 flex-col" ref={host} />;
}
