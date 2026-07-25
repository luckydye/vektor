import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  type CodeTokenRange,
  ensureLanguage,
  grammarFor,
  normalizeLanguage,
  tokenRanges,
} from "#editor/prism.ts";

export const codeBlockHighlightKey = new PluginKey<DecorationSet>("codeBlockHighlight");

/**
 * Tokens are cached per ProseMirror node. Nodes are immutable and shared
 * between transactions, so an untouched code block keeps its cache entry while
 * only the edited block is re-tokenized.
 */
type CachedTokens = { language: string; ranges: CodeTokenRange[] };
const tokenCache = new WeakMap<ProseMirrorNode, CachedTokens>();

function rangesFor(node: ProseMirrorNode, language: string): CodeTokenRange[] {
  const cached = tokenCache.get(node);
  if (cached && cached.language === language) return cached.ranges;

  const grammar = grammarFor(language);
  if (!grammar) return [];

  const ranges = tokenRanges(node.textContent, grammar, language);
  tokenCache.set(node, { language, ranges });
  return ranges;
}

/** Exported for tests; the plugin below is the only production caller. */
export function buildCodeBlockDecorations(
  doc: ProseMirrorNode,
  requestLanguage: (language: string) => void,
): Decoration[] {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") {
      // Text blocks can't contain a code block, so skip their inline content.
      return !node.isTextblock;
    }

    const language = normalizeLanguage(node.attrs.language);
    if (!language) return false;

    if (!grammarFor(language)) {
      requestLanguage(language);
      return false;
    }

    // A code block holds plain text only, so text offsets map straight onto
    // document positions after the opening token.
    const start = pos + 1;
    for (const range of rangesFor(node, language)) {
      decorations.push(
        Decoration.inline(start + range.from, start + range.to, {
          class: range.className,
        }),
      );
    }

    return false;
  });

  return decorations;
}

/**
 * Syntax highlighting for code blocks in the editor.
 *
 * Highlighting is applied as decorations rather than by rewriting the DOM:
 * ProseMirror owns the markup inside a code block, and replacing it would
 * fight the editor and break collaborative cursors.
 */
export const CodeBlockHighlight = Extension.create({
  name: "codeBlockHighlight",

  addProseMirrorPlugins() {
    let editorView: EditorView | null = null;
    const requested = new Set<string>();

    /**
     * Grammars load asynchronously. The first pass over a block whose grammar
     * is missing leaves it plain and kicks off the import; when it lands, an
     * empty transaction re-runs the decoration build.
     */
    const requestLanguage = (language: string) => {
      if (requested.has(language)) return;
      requested.add(language);

      void ensureLanguage(language).then((grammar) => {
        if (!grammar || !editorView || editorView.isDestroyed) return;
        editorView.dispatch(editorView.state.tr.setMeta(codeBlockHighlightKey, true));
      });
    };

    return [
      new Plugin<DecorationSet>({
        key: codeBlockHighlightKey,
        state: {
          init: (_config, state) =>
            DecorationSet.create(
              state.doc,
              buildCodeBlockDecorations(state.doc, requestLanguage),
            ),
          apply(tr, decorations) {
            if (!tr.docChanged && !tr.getMeta(codeBlockHighlightKey)) {
              return decorations.map(tr.mapping, tr.doc);
            }
            return DecorationSet.create(
              tr.doc,
              buildCodeBlockDecorations(tr.doc, requestLanguage),
            );
          },
        },
        props: {
          decorations: (state) => codeBlockHighlightKey.getState(state),
        },
        view(view) {
          editorView = view;
          return {
            destroy() {
              editorView = null;
            },
          };
        },
      }),
    ];
  },
});
