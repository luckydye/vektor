import { diffArrays } from "diff";

/**
 * Split an HTML string into a flat token stream suitable for a word-level
 * diff. Tags are kept as single, atomic tokens so the document structure is
 * never torn apart; text between tags is split into individual words and
 * whitespace runs so changes can be highlighted at word granularity.
 */
function tokenizeHtml(html: string): string[] {
  const tokens: string[] = [];
  // A tag runs to its closing `>`, but `>` is legal (and unescaped) inside a
  // quoted attribute value, so skip over quoted strings rather than stopping at
  // the first `>` — otherwise `<img alt="a > b">` would be torn apart. Comments
  // are matched whole so a `>` inside them does not split the token either.
  const chunkPattern = /<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g;
  let chunk: RegExpExecArray | null = chunkPattern.exec(html);

  while (chunk !== null) {
    const value = chunk[0];

    if (value.startsWith("<")) {
      tokens.push(value);
    } else {
      // Each word carries its leading whitespace so the diff aligns on whole
      // words: keeping spaces as separate tokens creates many identical match
      // points that let the shortest-edit-script shuffle words and produce a
      // noisy, alternating redline instead of clean grouped changes.
      const words = value.match(/\s*\S+|\s+/g);
      if (words) tokens.push(...words);
    }

    chunk = chunkPattern.exec(html);
  }

  return tokens;
}

function isTag(token: string): boolean {
  return token.startsWith("<");
}

// Void/embedded elements that render as their own visible box. Unlike
// structural tags (<p>, <li>, <td>, …) these carry no text to mark and have no
// separate closing tag, so a changed one can be wrapped in a marker directly to
// show it as added/removed. Structural tags stay verbatim so markers never span
// a block boundary.
const VOID_MEDIA_TAGS = new Set(["img", "hr"]);

function isVoidMediaTag(token: string): boolean {
  if (!token.startsWith("<") || token.startsWith("</")) return false;
  const name = token.match(/^<([a-zA-Z0-9-]+)/)?.[1]?.toLowerCase();
  return name !== undefined && VOID_MEDIA_TAGS.has(name);
}

/**
 * Wrap a run of text in an inline change marker, leaving surrounding
 * whitespace outside the marker so the highlight hugs the words themselves.
 */
function wrapText(text: string, tag: "ins" | "del", className: string): string {
  const lead = text.match(/^\s+/)?.[0] ?? "";
  const trail = text.match(/\s+$/)?.[0] ?? "";
  const core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  return `${lead}<${tag} class="${className}">${core}</${tag}>${trail}`;
}

/**
 * Emit a run of changed tokens. Text runs are wrapped in an inline text marker
 * and void/embedded elements (images, rules) in a media marker, while
 * structural tags are emitted verbatim so markers stay inline and the
 * surrounding block structure remains valid. An attribute-only change to a
 * media element arrives here as a remove of the old tag and an add of the new
 * one, so both states are marked without any special handling.
 */
function renderChange(
  tokens: string[],
  tag: "ins" | "del",
  textClass: string,
  mediaClass: string,
): string {
  let out = "";
  let buffer = "";

  const flush = () => {
    if (buffer) {
      out += wrapText(buffer, tag, textClass);
      buffer = "";
    }
  };

  for (const token of tokens) {
    if (!isTag(token)) {
      buffer += token;
      continue;
    }

    flush();
    if (isVoidMediaTag(token)) {
      out += `<${tag} class="${mediaClass}">${token}</${tag}>`;
    } else {
      out += token;
    }
  }

  flush();
  return out;
}

/**
 * Produce a single, rendered HTML string that shows the changes between two
 * document HTML snapshots inline: removed text/media is wrapped in `<del>` and
 * added text/media in `<ins>`, all carrying classes the document stylesheet
 * turns into a red strikethrough / green highlight redline (and a red/green
 * outline for images and rules). Unchanged content and the document's block
 * structure are preserved so the result reads like the document itself rather
 * than a source-level diff.
 */
export function inlineHtmlDiff(baseHtml: string, revisionHtml: string): string {
  const changes = diffArrays(tokenizeHtml(baseHtml), tokenizeHtml(revisionHtml));

  let out = "";
  for (const change of changes) {
    if (change.added) {
      out += renderChange(change.value, "ins", "diff-ins", "diff-ins-media");
    } else if (change.removed) {
      out += renderChange(change.value, "del", "diff-del", "diff-del-media");
    } else {
      out += change.value.join("");
    }
  }

  return out;
}
