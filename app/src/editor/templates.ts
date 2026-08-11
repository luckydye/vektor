import { getActiveEditor } from "./activeEditor.ts";

/**
 * Parses a stored document body into an inert document. Nothing in it loads or
 * runs — unlike assigning to a detached element, where an `<img>` still fetches
 * its source.
 */
function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(html, "text/html").body;
}

/**
 * Comment anchors carry the id of a thread on the document the content was
 * written in. Pulled into a different document they would mark text against
 * comments that are not there, so they are unwrapped on the way in.
 */
export function stripDocumentScopedMarks(html: string): string {
  const body = parseBody(html);
  for (const anchor of body.querySelectorAll("[data-comment-id]")) {
    anchor.replaceWith(...anchor.childNodes);
  }
  return body.innerHTML;
}

/** One line of plain text from a template body, for the picker card. */
export function templatePreviewText(html: string, maxLength = 140): string {
  const text = parseBody(html).textContent?.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}

/**
 * The picker sits in front of a draft whose editor mounts in the same tick the
 * picker is dismissed, so the active editor can be a frame or two away.
 */
const EDITOR_WAIT_FRAMES = 30;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForActiveEditor() {
  for (let frame = 0; frame < EDITOR_WAIT_FRAMES; frame++) {
    const editor = getActiveEditor();
    if (editor) return editor;
    await nextFrame();
  }
  return null;
}

/**
 * Inserts a template body at the cursor. It goes in through the editor rather
 * than the document API on purpose: the insertion is then an ordinary edit, so
 * it syncs to everyone in the room, lands in the undo stack, and is carried by
 * whichever save the user reaches for — including the one that creates the
 * document a draft does not have yet.
 *
 * Returns false when no editor ever became available, so the caller can say so
 * rather than dropping the click silently.
 */
export async function insertTemplateContent(content: string): Promise<boolean> {
  const editor = await waitForActiveEditor();
  if (!editor) return false;

  editor.chain().focus().insertContent(stripDocumentScopedMarks(content)).run();
  return true;
}
