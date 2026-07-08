import { diffArrays } from "diff";

/**
 * Split an HTML string into a flat token stream suitable for a word-level
 * diff. Tags are kept as single, atomic tokens so the document structure is
 * never torn apart; text between tags is split into individual words and
 * whitespace runs so changes can be highlighted at word granularity.
 */
function tokenizeHtml(html: string): string[] {
  const tokens: string[] = [];
  const chunkPattern = /<[^>]+>|[^<]+/g;
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
 * Emit a run of changed tokens. Text runs are wrapped in an inline marker,
 * while tags are emitted verbatim (and never wrapped) so markers stay inline
 * and the surrounding block structure remains valid.
 */
function renderChange(tokens: string[], tag: "ins" | "del", className: string): string {
  let out = "";
  let buffer = "";

  const flush = () => {
    if (buffer) {
      out += wrapText(buffer, tag, className);
      buffer = "";
    }
  };

  for (const token of tokens) {
    if (isTag(token)) {
      flush();
      out += token;
    } else {
      buffer += token;
    }
  }

  flush();
  return out;
}

/**
 * Produce a single, rendered HTML string that shows the changes between two
 * document HTML snapshots inline: removed text is wrapped in `<del>` and added
 * text in `<ins>`, both carrying classes the document stylesheet turns into a
 * red strikethrough / green highlight redline. Unchanged content and the
 * document's block structure are preserved so the result reads like the
 * document itself rather than a source-level diff.
 */
export function inlineHtmlDiff(baseHtml: string, revisionHtml: string): string {
  const changes = diffArrays(tokenizeHtml(baseHtml), tokenizeHtml(revisionHtml));

  let out = "";
  for (const change of changes) {
    if (change.added) {
      out += renderChange(change.value, "ins", "diff-ins");
    } else if (change.removed) {
      out += renderChange(change.value, "del", "diff-del");
    } else {
      out += change.value.join("");
    }
  }

  return out;
}
