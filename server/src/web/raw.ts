import type { JSX } from "solid-js";
import { ssr } from "solid-js/web";

/**
 * Markup that is already HTML, placed in a server-rendered tree as it is.
 *
 * Only for the server: it has no client counterpart, so it belongs in pages that
 * are not hydrated. The string must be trusted or sanitized by the caller.
 */
export function raw(html: string): JSX.Element {
  return ssr([html]) as unknown as JSX.Element;
}
