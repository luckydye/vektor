import * as Y from "yjs";
import {
  type Attrs,
  type DocMark,
  type DocNode,
  defaultAttrs,
  markSpec,
} from "./specs.ts";

/**
 * Document tree → `Y.XmlFragment`.
 *
 * This follows y-prosemirror's `createTypeFromElementNode` /
 * `createTypeFromTextNodes` exactly, because the editor's sync plugin reads the
 * result back with the inverse of those functions. Anything shaped differently
 * is not an error there — `createNodeFromYElement` catches the schema failure
 * and *deletes the Y item*, so the first client to open the room silently loses
 * the content. `serialization-html-parity.spec.ts` pins the encoding against
 * `prosemirrorToYDoc` for exactly that reason.
 */

/** Builds a fresh Y.Doc whose `default` fragment holds the document. */
export function docToYDoc(doc: DocNode): Y.Doc {
  const ydoc = new Y.Doc();
  applyDocToFragment(ydoc.getXmlFragment("default"), doc);
  return ydoc;
}

/** Replaces a fragment's contents with the document, in one transaction. */
export function applyDocToFragment(fragment: Y.XmlFragment, doc: DocNode): void {
  const nodes = docNodesToY(doc.content ?? []);
  const replace = () => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    fragment.insert(0, nodes);
  };
  const ydoc = fragment.doc;
  // A fragment that is not yet attached to a document has nothing to transact
  // on; it integrates when whoever built it attaches it.
  if (ydoc) ydoc.transact(replace);
  else replace();
}

/**
 * Converts a run of sibling nodes. Adjacent text nodes coalesce into a single
 * `Y.XmlText` written as one delta — the shape y-prosemirror produces, and the
 * reason `normalize.ts` merges neighbouring text nodes that carry equal marks.
 */
export function docNodesToY(nodes: DocNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as DocNode;
    if (node.type !== "text") {
      out.push(elementToY(node));
      continue;
    }
    const run: DocNode[] = [];
    while (i < nodes.length && nodes[i]?.type === "text") {
      run.push(nodes[i] as DocNode);
      i++;
    }
    i--;
    out.push(textNodesToY(run));
  }
  return out;
}

function elementToY(node: DocNode): Y.XmlElement {
  const element = new Y.XmlElement(node.type);
  for (const [name, value] of Object.entries(node.attrs ?? {})) {
    if (value === null || value === undefined) continue;
    // Attribute values keep their JavaScript type — a colwidth stays an array
    // of numbers, an indent stays a number. The editor reads them back as node
    // attributes, so coercing them to strings here would change the document.
    element.setAttribute(name, value as string);
  }
  element.insert(0, docNodesToY(node.content ?? []));
  return element;
}

function textNodesToY(nodes: DocNode[]): Y.XmlText {
  const text = new Y.XmlText();
  text.applyDelta(
    nodes.map((node) => ({
      insert: node.text ?? "",
      attributes: markAttributes(node.marks),
    })),
  );
  return text;
}

/**
 * Marks as `Y.XmlText` formatting attributes, keyed by the bare mark name.
 *
 * y-prosemirror only uses the bare name for a mark that excludes itself; an
 * overlapping mark is keyed `name--<hash8>` instead. `specs.ts` asserts at
 * import time that every mark in this schema self-excludes, so this stays
 * correct by construction rather than by convention.
 */
function markAttributes(marks: DocMark[] | undefined): Record<string, Attrs> {
  const attributes: Record<string, Attrs> = {};
  for (const mark of marks ?? []) {
    const spec = markSpec(mark.type);
    attributes[mark.type] = spec
      ? { ...defaultAttrs(spec), ...(mark.attrs ?? {}) }
      : { ...(mark.attrs ?? {}) };
  }
  return attributes;
}
