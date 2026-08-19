# HTML export import

Imports a **rendered HTML export** — Confluence's "Export space > HTML" or
XWiki's "Export > HTML" — into a standalone Vektor space database. One command
per export, no staging step:

```sh
# Confluence: the directory holding index.html, <page>.html and attachments/
bun run scripts/confluence-html-to-space.ts <export-dir> \
  --out data/imports/<name>.db \
  --uploads data/imports/uploads \
  --confluence-url https://confluence.example.com

# XWiki: the directory holding pages/, attachment/ and index.html
bun run scripts/xwiki-html-to-space.ts <export-dir> \
  --out data/imports/<name>.db \
  --uploads data/imports/uploads
```

Each run prints the two `mv` commands that install the result. Restart the
server afterwards: `reconcileLocalSpaceIndex` scans `data/spaces/*.db`, so
`auth.db` needs no manual edit.

## Prefer the native export

A rendered HTML export is the **lossiest** input of the four importers here, and
these two scripts exist for exports that can no longer be taken any other way.
When the wiki is still reachable, export it natively instead:

| Source | Native export | Importer |
|---|---|---|
| Confluence Server/DC | XML space export (`entities.xml` + `attachments/`) | `confluence-export-to-staging.py` → `confluence-staging-to-space.ts` |
| XWiki | XAR | `xar-to-space.ts` |

What the native path gives you that HTML cannot:

- **Revision history.** An HTML export contains only the current rendering of
  each page, so these importers write a single revision per document. The XML
  path renumbers Confluence's whole version chain into `rev` 1..N.
- **Authorship.** The XML export carries a user id per version, mappable to a
  Vektor user with `--users`. HTML prints a display name, and only leaks an
  address where a profile link happens to contain one.
- **Both dates.** Confluence's HTML export prints one date per page, to the day,
  and does not say whether it is the creation or the modification date — so a
  page gets it for both. XWiki's HTML export does print both, to the minute.
- **Macro fidelity.** The XML path converts from storage-format source, so a
  macro is converted from its parameters. Here the macro is already rendered, and
  what a `<div class="task-macro">` meant has to be recovered from CSS classes.

## Options

Shared: `--name` / `--slug` name the space (defaulting to the Confluence space
name and key, or to the XWiki root page's title); `--out` is the database file;
`--owner` is the Vektor user id that owns the space; `--uploads` is the directory
attachments are written under; `--max-attachment-mb` (default 100) refuses
anything larger and reports it; `--limit N` keeps smoke tests fast.

Confluence only: `--confluence-url` sets the origin that links to pages outside
the export are repointed at — omit it and they become plain text.
`--no-comments` drops page comment threads instead of appending them.

Both refuse to overwrite an existing database or a slug already active in
`auth.db`.

## What it preserves

- **Hierarchy.** Confluence takes the tree from `index.html`, which is the only
  place sibling order is recorded; XWiki takes it from the `pages/` directory
  layout, which *is* the page reference. Paths are keyed by page id (Confluence)
  or by the encoded reference (XWiki), because sibling titles repeat.
- **Attachments,** content-addressed exactly like `vektor upload`:
  `sha256(bytes)`, key `<hash[0:2]>/<hash>.<ext>`. This matters more than usual
  here — Confluence's HTML export writes every *version* of every attachment, so
  3063 files in one real export collapsed to 682 payloads. Files that a page
  lists but never embeds are uploaded too, so nothing is lost.
- **Inlined images.** `data:` sources are uploaded like any other attachment,
  because the schema deliberately refuses them.
- **Titles** as a `title` property (Vektor has no title column).
- **Dates** as described above.
- **Comments.** Confluence page comments are appended under a `Kommentare`
  heading, one blockquote per comment with its author and timestamp. Without
  this they would simply be dropped — the schema has no place for them.

Categories work exactly as in `xar-to-space.ts`: every first-level page under the
space home becomes a `category`, one that renders empty is replaced by its
category, and its children move up a level.

## Content conversion

Both scripts share `lib/html-clean.ts`, a tree rewriter over the export's HTML
with a per-format rule callback. Three problems make the raw export unusable and
motivate the whole module:

- Any block tag the schema has no node for is captured **verbatim** as an
  `htmlBlock`, so a leftover `<div class="innerCell">` freezes export
  scaffolding into the document. Every wrapper has to be resolved, not left to
  the parser. Both imports of all four real exports end at zero `htmlBlock`s.
- The schema has no inline image and no inline code block, so an `<img>` inside a
  `<p>` is **dropped** on parse rather than moved. Confluence puts every image
  inside a paragraph, so blocks are lifted out of inline containers.
- `htmlToDoc` decodes only a handful of named entities, so `H&ouml;lzinger`
  would be stored as those eight literal characters. Entities are decoded on the
  way in and re-escaped on the way out; anything missing from the table is
  counted and reported.

| Export markup | Vektor |
|---|---|
| `div.columnLayout` + `div.cell` | `<div data-type="column-layout">` |
| `div.confluence-information-macro`, `div.box`, `div.panel` | `<blockquote>` with a bold title |
| `div.code.panel` + `pre[data-syntaxhighlighter-params]` | `<pre><code class="language-…">` |
| `ul.inline-task-list`, `div.task-macro` | `<ul data-type="taskList">` |
| `div.xform` (an XWiki application sheet) | a two-column field/value `<table>` |
| `span.status-macro`, `span.statusBox` | `<span style="background-color:…;color:…">` |
| `a[href*="/display/~email"]`, `a[href*="/XWiki/user"]` | `<user-mention email>` |
| `a.confluence-embedded-file` | `<file-attachment src filename>` |
| `<time datetime>` | `<date-picker data-date>` |
| `<iframe src>` | a link to the URL |
| emoticon `<img>` | inline Unicode glyph |
| `div.expand-container` | its title in bold, then its content |
| `childpages`, `pagetree`, `toc`, contributors, `div.xtree` | dropped (live queries) |

Attribute policy is a per-tag allowlist: an export carries dozens of
`data-linked-resource-*` and `aui-*` attributes per element that the schema never
reads and that would otherwise be stored on every document forever. Inline styles
are filtered down to `color`, `background-color` and `text-align`.

Both scripts then round-trip every body through `htmlToDoc`/`docToHtml` and
assert the stored content is a fixed point of that round-trip. This is not
cosmetic — the editor's Yjs sync plugin *deletes* schema-invalid nodes rather
than failing, so unnormalized content would silently lose data on first open.

## Reporting

Both fail loudly and count everything they touch: constructs dropped, wrappers
flattened, duplicate titles that needed a numbered slug, links that point outside
the export, unknown entities, and attachments that did not resolve. Each body is
also checked for leftover export paths, `data:` sources and `htmlBlock`s.

An unresolved *page* link is normal — it points into a wiki the export does not
contain. An unresolved *attachment* is printed as a `WARNING`, because it usually
means a lost image; in the real exports these turned out to be references to
pages outside the exported subtree, whose files were never in the export at all.

## Known limitations

- One revision per document, and no authorship beyond the space owner.
- Confluence column widths are lost; tables get the schema's default 200px
  columns.
- Dynamic macros have no static equivalent and are dropped, counted per macro.
- `search_text` is populated so keyword search works immediately, but
  `search_embedding` is left null for the server's own backfill.
- User mentions carry the source wiki's email address, so they resolve once those
  accounts exist in Vektor.
