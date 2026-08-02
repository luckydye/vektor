import * as Y from "yjs";
import { addMark, type DocMark, type DocNode } from "./specs.ts";

/**
 * `Y.XmlFragment` → document tree.
 *
 * The easy direction: a recursive walk, with `Y.XmlText` deltas turned back
 * into text nodes and their formatting attributes back into marks. Nothing is
 * normalized here — this reads live room state, and rewriting it on the way out
 * would make what the server persists disagree with what the clients see.
 */

/** Reads the `default` fragment of a room document. */
export function yDocToDoc(ydoc: Y.Doc): DocNode {
  return { type: "doc", content: fragmentToNodes(ydoc.getXmlFragment("default")) };
}

export function fragmentToNodes(fragment: Y.XmlFragment): DocNode[] {
  const out: DocNode[] = [];
  for (const child of fragment.toArray()) out.push(...yTypeToNodes(child));
  return out;
}

function yTypeToNodes(
  type: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment,
): DocNode[] {
  if (type instanceof Y.XmlText) return textToNodes(type);
  if (type instanceof Y.XmlElement) return [elementToNode(type)];
  // Hooks have no document representation; a bare fragment is flattened.
  if (type instanceof Y.XmlFragment) return fragmentToNodes(type);
  return [];
}

function elementToNode(element: Y.XmlElement): DocNode {
  const node: DocNode = { type: element.nodeName };
  const attrs = element.getAttributes() as Record<string, unknown>;
  if (Object.keys(attrs).length > 0) node.attrs = { ...attrs };

  const content: DocNode[] = [];
  for (const child of element.toArray()) content.push(...yTypeToNodes(child));
  if (content.length > 0) node.content = content;
  return node;
}

/** A mark key y-prosemirror hashed because the mark did not exclude itself. */
const HASHED_MARK_KEY = /^(.*)--[A-Za-z0-9+/=]{8}$/;

function textToNodes(text: Y.XmlText): DocNode[] {
  const out: DocNode[] = [];
  for (const op of text.toDelta() as {
    insert?: unknown;
    attributes?: Record<string, unknown>;
  }[]) {
    if (typeof op.insert !== "string" || !op.insert) continue;
    const node: DocNode = { type: "text", text: op.insert };
    const marks = deltaMarks(op.attributes);
    if (marks.length > 0) node.marks = marks;
    out.push(node);
  }
  return out;
}

function deltaMarks(attributes: Record<string, unknown> | undefined): DocMark[] {
  let marks: DocMark[] = [];
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const name = HASHED_MARK_KEY.exec(key)?.[1] ?? key;
    const attrs =
      value && typeof value === "object" ? (value as DocMark["attrs"]) : undefined;
    marks = addMark(marks, {
      type: name,
      ...(attrs && Object.keys(attrs).length > 0 ? { attrs } : {}),
    });
  }
  return marks;
}
