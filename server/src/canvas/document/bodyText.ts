/**
 * A body's rich text as the markdown the canvas renders and the snapshot JSON
 * stores in `data.text`, built with the document schema as documents build
 * their Y.Docs from content.
 */

import * as Y from "yjs";
import { BODY_FIELD, bodyDoc } from "#canvas/document/format/object.ts";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { fragmentToNodes } from "#documents/schema/yDecode.ts";
import { applyDocToFragment } from "#documents/schema/yEncode.ts";
import { renderMessageMarkdown, tiptapJsonToMarkdown } from "#utils/markdown.ts";

export function bodyMarkdown(state: Uint8Array | null): string {
  if (!state) return "";
  return fragmentMarkdown(bodyDoc(state).getXmlFragment(BODY_FIELD));
}

export function fragmentMarkdown(fragment: Y.XmlFragment): string {
  return tiptapJsonToMarkdown({ type: "doc", content: fragmentToNodes(fragment) });
}

/** Replaces the body text of `doc` with `markdown`, in one transaction. */
export function writeBodyMarkdown(doc: Y.Doc, markdown: string): void {
  applyDocToFragment(
    doc.getXmlFragment(BODY_FIELD),
    htmlToDoc(renderMessageMarkdown(markdown)),
  );
}

/**
 * A new body's whole state holding `markdown`. `clientID` pins the encoding,
 * for a caller that must build the same bytes twice.
 */
export function bodyFromMarkdown(markdown: string, clientID?: number): Uint8Array {
  const doc = new Y.Doc();
  if (clientID !== undefined) doc.clientID = clientID;
  writeBodyMarkdown(doc, markdown);
  return Y.encodeStateAsUpdate(doc);
}
