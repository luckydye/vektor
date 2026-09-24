# Confluence import

Imports a Confluence Server/DC **space export** (`entities.xml` + `attachments/`)
into a standalone Vektor space database. Two stages:

```sh
# 1. export -> staging data (Python 3.9+, stdlib only)
python3 scripts/confluence-export-to-staging.py <export-dir> \
  --owner <vektorUserId> \
  --confluence-url https://confluence.example.com \
  --users /tmp/users.json \
  --out data/confluence-staging

# 2. staging -> space database + uploads (Bun)
bun run scripts/confluence-staging-to-space.ts --staging data/confluence-staging
```

Restart the server afterwards: `reconcileLocalSpaceIndex` scans
`data/spaces/*.db`, so `auth.db` needs no manual edit.

Two stages because `entities.xml` is hundreds of MB and needs a streaming XML
parser, while revision snapshots need brotli, which the system Python lacks.

## Options

**Stage 1** — `--owner` (required) is the Vektor user id that owns the space and
any content whose author cannot be mapped. `--space-name` / `--space-slug`
default to the Confluence space name and key. `--confluence-url` sets the origin
that unresolvable page links are repointed to; omit it and they stay plain text.
`--users` takes a JSON map of lowercase email to Vektor user id, so authorship is
preserved wherever the account already exists — generate it from your auth
database and keep it out of the repo:

```sh
sqlite3 -json data/auth.db "select id, lower(email) as email from user" \
  | jq 'map({(.email): .id}) | add' > /tmp/users.json
```

`--page-limit N` and `--max-revisions N` keep smoke tests fast.

**Stage 2** — `--staging`, `--spaces`, `--uploads` override paths. It refuses to
overwrite an existing space database or a slug already active in `auth.db`;
`--force` replaces one deliberately.

## What it preserves

- **Hierarchy.** `Page.parent` → `document.parent_id`, ordered by Confluence
  `position`.
- **Revisions.** Confluence keeps each version as its own `Page` row pointing at
  the current one via `originalVersion`. Those are renumbered to a contiguous
  `rev` 1..N with `parent_rev` chained; `current_rev` and `published_rev` both
  equal N. The original version number goes into `revision.message`. Rows are
  inserted directly rather than through `createRevision`, whose 3-hour overwrite
  window would otherwise collapse the whole history into one revision, and whose
  `createdAt` would be import time instead of the Confluence timestamp.
- **Titles** as a `title` property (Vektor has no title column), plus
  `layout=document`.
- **Attachments** content-addressed exactly like `vektor upload`:
  `sha256(bytes)`, key `<hash[0:2]>/<hash>.<ext>`. Identical payloads on
  different pages collapse to one key and one `file` row.
- **Ids** are UUID5-derived from the source object ids, so a re-run produces the
  same ids.

## Categories replace empty container pages

Every first-level page under the space home becomes a `category`, and that page
plus all its descendants get a `category` property.

In Confluence the space home and most first-level pages exist only to hold
children. A category already plays that role, so a first-level page that renders
empty is dropped and its children move up a level, keeping the category that
covers the subtree. Emptiness is judged on the *converted* output, because those
pages typically contain nothing but a `children` or `pagetree` macro, which has
no static equivalent. First-level pages that do have content stay documents.
Container pages deeper in the tree are always kept — nothing replaces them there.

## Content conversion

Confluence storage XHTML → the node and mark specs in
`src/documents/schema/specs.ts`.

| Confluence | Vektor |
|---|---|
| `<ac:link><ri:user>` | `<user-mention email>` |
| `<ac:link><ri:page>` resolvable | `<a href="/<space>/doc/<slug>">` |
| `<ac:link><ri:page>` not in import | `<a>` to the Confluence page |
| `<ac:image>` | `<img>` at block level |
| `view-file` | `<file-attachment src filename>` |
| `code` | `<pre><code class="language-…">` |
| `status` | `<span style="background-color:…;color:…">` |
| `info`/`note`/`warning`/`tip`/`panel` | `<blockquote>` with a bold title |
| `jira` | `<ticket-link data-ticket-id>` |
| `<ac:task-list>` | `<ul data-type="taskList">` |
| `<ac:layout-section>` | `<div data-type="column-layout">` |
| `<ac:emoticon>` and emoticon `<img>` | inline Unicode glyph |
| `<time datetime>` | `<date-picker data-date>` |
| `toc`, `children`, `pagetree`, `attachments`, … | dropped (live queries) |

Stage 1 also enforces the structural rules the schema needs: headings clamped to
h1–h4; `image`/`video`/`file-attachment`/`pre`/`table` hoisted out of paragraphs,
headings and inline wrappers because they are block nodes; `<li>` and task items
starting with a paragraph; only blocks inside cells, quotes and column items.

Stage 2 then round-trips every body through `htmlToDoc`/`docToHtml`. This is not
cosmetic — the editor's Yjs sync plugin *deletes* schema-invalid nodes rather
than failing, so unnormalized content would silently lose data on first open. It
also fills in what the renderer owns (a `date-picker`'s visible label, canonical
attribute order), and a validation check asserts the stored content is a fixed
point of that round-trip.

## Reporting

Both stages count everything they touch and fail loudly. Stage 1 writes
`<out>/report.json` with per-construct counters, unknown macros, unresolvable
page links and unmatched mention names. Stage 2 runs 17 validation queries
against the finished file (row counts, orphan parents, duplicate slugs,
`current_rev`/`published_rev` agreement, dangling upload references, leftover
Confluence markup, normalization stability) and exits non-zero on any failure.

## Known limitations

- Only `contentStatus = 'current'` pages are imported; trashed pages and editor
  drafts are skipped.
- Links into other Confluence spaces cannot resolve — a space export contains one
  space. They repoint to `--confluence-url` when given.
- Dynamic macros have no static equivalent and are dropped, counted per macro.
- `search_text` is populated so keyword search works immediately, but
  `search_embedding` is left null for the server's own backfill.
- User mentions carry the Confluence email address, so they resolve once those
  accounts exist in Vektor.
