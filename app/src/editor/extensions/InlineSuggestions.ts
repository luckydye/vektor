import { Extension } from "@tiptap/core";
import { parsePatch } from "diff";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { prettyPrintHtml } from "../../utils/prettyHtml.ts";
import { stripScriptTags } from "../../utils/utils.ts";

export interface InlineSuggestion {
  rev: number;
  message: string | null;
  patch: string;
}

interface DiffLine {
  type: "add" | "remove" | "context" | "empty";
  content: string;
}

interface DiffRow {
  left: DiffLine;
  right: DiffLine;
}

const INLINE_CONTEXT_ROWS = 1;

interface SuggestionHunk {
  revisionRev: number;
  message: string | null;
  hunkIndex: number;
  oldStart: number;
  oldLines: number;
  rows: DiffRow[];
}

interface InlineSuggestionsState {
  suggestions: InlineSuggestion[];
}

const inlineSuggestionsPluginKey = new PluginKey<InlineSuggestionsState>("inlineSuggestions");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    inlineSuggestions: {
      setInlineSuggestions: (suggestions: InlineSuggestion[]) => ReturnType;
      clearInlineSuggestions: () => ReturnType;
    };
  }
}

function parseSuggestionHunks(suggestions: InlineSuggestion[]): SuggestionHunk[] {
  const hunks: SuggestionHunk[] = [];

  for (const suggestion of suggestions) {
    const patches = parsePatch(suggestion.patch);

    for (const file of patches) {
      file.hunks.forEach((hunk, hunkIndex) => {
        const rows: DiffRow[] = [];
        let pendingRemove: string[] = [];
        let pendingAdd: string[] = [];

        const flushPending = () => {
          const rowCount = Math.max(pendingRemove.length, pendingAdd.length);
          for (let index = 0; index < rowCount; index += 1) {
            rows.push({
              left: pendingRemove[index]
                ? { type: "remove", content: pendingRemove[index] }
                : { type: "empty", content: "" },
              right: pendingAdd[index]
                ? { type: "add", content: pendingAdd[index] }
                : { type: "empty", content: "" },
            });
          }

          pendingRemove = [];
          pendingAdd = [];
        };

        for (const line of hunk.lines) {
          const marker = line[0];
          const content = line.slice(1);

          if (marker === "-") {
            pendingRemove.push(content);
            continue;
          }

          if (marker === "+") {
            pendingAdd.push(content);
            continue;
          }

          if (marker === "\\") {
            continue;
          }

          flushPending();
          rows.push({
            left: { type: "context", content },
            right: { type: "context", content },
          });
        }

        flushPending();

        hunks.push({
          revisionRev: suggestion.rev,
          message: suggestion.message,
          hunkIndex,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          rows,
        });
      });
    }
  }

  return hunks;
}

function buildTopLevelBlocks(view: EditorView, doc: ProseMirrorNode) {
  const domChildren = Array.from(view.dom.children).filter((child) => {
    return !(child instanceof HTMLElement && child.classList.contains("wiki-inline-suggestion"));
  });
  const blocks: Array<{
    lineStart: number;
    lineEnd: number;
    pos: number;
    html: string;
    text: string;
  }> = [];

  let lineCursor = 1;
  let childIndex = 0;

  doc.forEach((node, offset) => {
    const domNode = domChildren[childIndex];
    childIndex += 1;

    if (!(domNode instanceof HTMLElement)) {
      return;
    }

    const html = prettyPrintHtml(domNode.outerHTML);
    const lines = html.split("\n").length;
    blocks.push({
      lineStart: lineCursor,
      lineEnd: lineCursor + Math.max(lines, 1) - 1,
      pos: offset + node.nodeSize,
      html,
      text: domNode.textContent?.trim().replace(/\s+/g, " ") || "",
    });
    lineCursor += Math.max(lines, 1);
  });

  return blocks;
}

function normalizeText(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isStructuralHtmlLine(value: string) {
  const trimmed = value.trim();
  return /^<\/?[\w-]+(?:\s[^>]*)?>$/.test(trimmed);
}

function getSearchNeedles(rows: DiffRow[]) {
  const lines = rows
    .flatMap((row) => [row.left, row.right])
    .filter((line) => line.type !== "empty")
    .map((line) => line.content.trim())
    .filter((line) => line.length > 0);

  const changed = lines.filter((line) => !isStructuralHtmlLine(line));
  const source = changed.length > 0 ? changed : lines;

  return source.slice(0, 8).map((line) => ({
    html: line,
    text: normalizeText(line),
  }));
}

function getAnchorPosition(
  blocks: Array<{
    lineStart: number;
    lineEnd: number;
    pos: number;
    html: string;
    text: string;
  }>,
  hunk: SuggestionHunk,
): number | null {
  if (blocks.length === 0) {
    return null;
  }

  const targetStart = hunk.oldStart;
  const targetEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;
  const searchNeedles = getSearchNeedles(hunk.rows);

  if (searchNeedles.length > 0) {
    const matchedBlock = blocks
      .map((block) => {
        const score = searchNeedles.reduce((total, needle) => {
          let next = total;
          if (needle.html && block.html.includes(needle.html)) {
            next += 3;
          }
          if (needle.text && block.text.toLowerCase().includes(needle.text)) {
            next += 2;
          }
          return next;
        }, 0);

        return {
          block,
          score,
          distanceToEnd: Math.abs(block.lineEnd - targetEnd),
        };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.distanceToEnd !== right.distanceToEnd) {
          return left.distanceToEnd - right.distanceToEnd;
        }
        return right.block.lineEnd - left.block.lineEnd;
      })[0];

    if (matchedBlock) {
      return matchedBlock.block.pos;
    }
  }

  const overlapping = [...blocks].reverse().find((block) => {
    return block.lineStart <= targetEnd && block.lineEnd >= targetStart;
  });
  if (overlapping) {
    return overlapping.pos;
  }

  const preceding = [...blocks].reverse().find((block) => block.lineStart <= targetEnd);
  return preceding?.pos ?? blocks[blocks.length - 1]?.pos ?? null;
}

function isChangedRow(row: DiffRow) {
  return row.left.type !== "context" || row.right.type !== "context";
}

function createCollapsedRow(): DiffRow {
  return {
    left: { type: "empty", content: "..." },
    right: { type: "empty", content: "..." },
  };
}

function trimRows(rows: DiffRow[]): DiffRow[] {
  const changedIndexes = rows
    .map((row, index) => (isChangedRow(row) ? index : -1))
    .filter((index) => index >= 0);

  if (changedIndexes.length === 0) {
    return rows;
  }

  const slices: Array<{ start: number; end: number }> = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - INLINE_CONTEXT_ROWS);
    const end = Math.min(rows.length - 1, index + INLINE_CONTEXT_ROWS);
    const lastSlice = slices[slices.length - 1];

    if (lastSlice && start <= lastSlice.end + 1) {
      lastSlice.end = Math.max(lastSlice.end, end);
      continue;
    }

    slices.push({ start, end });
  }

  const trimmed: DiffRow[] = [];
  slices.forEach((slice, index) => {
    if (index > 0) {
      trimmed.push(createCollapsedRow());
    }

    trimmed.push(...rows.slice(slice.start, slice.end + 1));
  });

  return trimmed;
}

function createLineElement(line: DiffLine) {
  const row = document.createElement("div");
  row.className = "wiki-inline-suggestion-line";

  if (line.type === "remove") {
    row.dataset.kind = "remove";
  } else if (line.type === "add") {
    row.dataset.kind = "add";
  } else if (line.type === "empty") {
    row.dataset.kind = "empty";
  } else {
    row.dataset.kind = "context";
  }

  const marker = document.createElement("span");
  marker.className = "wiki-inline-suggestion-marker";
  marker.textContent =
    line.type === "remove"
      ? "-"
      : line.type === "add"
        ? "+"
        : line.type === "empty"
          ? "..."
          : " ";

  const content = document.createElement("span");
  content.className = "wiki-inline-suggestion-content";
  if (line.type !== "empty") {
    content.innerHTML = stripScriptTags(line.content || "&nbsp;");
  }

  row.append(marker, content);
  return row;
}

function renderSuggestionWidget(hunk: SuggestionHunk) {
  const root = document.createElement("div");
  root.className = "wiki-inline-suggestion";
  root.contentEditable = "false";
  root.draggable = false;

  const swallowDragEvent = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  root.addEventListener("dragenter", swallowDragEvent);
  root.addEventListener("dragover", swallowDragEvent);
  root.addEventListener("dragleave", swallowDragEvent);
  root.addEventListener("drop", swallowDragEvent);

  const header = document.createElement("div");
  header.className = "wiki-inline-suggestion-header";

  const heading = document.createElement("div");
  heading.className = "wiki-inline-suggestion-heading";
  heading.textContent = `Suggestion ${hunk.revisionRev}`;

  const message = document.createElement("div");
  message.className = "wiki-inline-suggestion-message";
  message.textContent = hunk.message || "Suggested changes";

  const acceptButton = document.createElement("button");
  acceptButton.type = "button";
  acceptButton.className = "wiki-inline-suggestion-accept";
  acceptButton.textContent = "Accept hunk";
  acceptButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent("inline-suggestion:accept", {
      detail: {
        revisionRev: hunk.revisionRev,
        hunkIndex: hunk.hunkIndex,
      },
    }));
  });

  header.append(heading, message, acceptButton);
  root.appendChild(header);

  const rows = document.createElement("div");
  rows.className = "wiki-inline-suggestion-lines";

  for (const row of trimRows(hunk.rows)) {
    if (row.left.type === "remove") {
      rows.appendChild(createLineElement(row.left));
    }

    if (row.right.type === "add") {
      rows.appendChild(createLineElement(row.right));
      continue;
    }

    if (row.left.type === "context" && row.right.type === "context") {
      rows.appendChild(createLineElement(row.left));
      continue;
    }

    if (row.left.type === "empty" && row.right.type === "empty") {
      rows.appendChild(createLineElement(row.left));
    }
  }

  root.appendChild(rows);
  return root;
}

export const InlineSuggestions = Extension.create({
  name: "inlineSuggestions",

  addCommands() {
    return {
      setInlineSuggestions: (suggestions) => ({ tr, dispatch }) => {
        dispatch?.(
          tr.setMeta(inlineSuggestionsPluginKey, {
            suggestions,
          }),
        );
        return true;
      },
      clearInlineSuggestions: () => ({ tr, dispatch }) => {
        dispatch?.(
          tr.setMeta(inlineSuggestionsPluginKey, {
            suggestions: [],
          }),
        );
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    let view: EditorView | null = null;

    return [
      new Plugin<InlineSuggestionsState>({
        key: inlineSuggestionsPluginKey,
        state: {
          init: () => ({
            suggestions: [],
          }),
          apply(tr, value) {
            const next = tr.getMeta(inlineSuggestionsPluginKey) as
              | InlineSuggestionsState
              | undefined;
            return next ?? value;
          },
        },
        props: {
          decorations(state) {
            if (!view) {
              return DecorationSet.empty;
            }

            const pluginState = inlineSuggestionsPluginKey.getState(state);
            if (!pluginState || pluginState.suggestions.length === 0) {
              return DecorationSet.empty;
            }

            const blocks = buildTopLevelBlocks(view, state.doc);
            const decorations = parseSuggestionHunks(pluginState.suggestions)
              .map((hunk) => {
                const pos = getAnchorPosition(blocks, hunk);
                if (pos === null) {
                  return null;
                }

                return Decoration.widget(
                  pos,
                  () => renderSuggestionWidget(hunk),
                  {
                    side: 1,
                    key: `${hunk.revisionRev}:${hunk.hunkIndex}:${pos}`,
                  },
                );
              })
              .filter((decoration): decoration is Decoration => decoration !== null);

            return DecorationSet.create(state.doc, decorations);
          },
        },
        view(editorView) {
          view = editorView;
          return {
            update(nextView) {
              view = nextView;
            },
            destroy() {
              view = null;
            },
          };
        },
      }),
    ];
  },
});
