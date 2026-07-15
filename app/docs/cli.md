# CLI Development Guide

## Architecture

The CLI is a single Bun-compiled binary built from `vektor.ts`. All commands are routed through `main()` in that file. Command implementations live in `src/cli/`.

```
vektor.ts               routing, global flag parsing, help text
src/cli/document.ts     cat, write, set, ls, query
src/cli/category.ts     category ls/create/edit/rm
src/cli/space.ts        space register/attach/enable/ls (direct auth database access)
src/cli/upload.ts       upload
src/cli/workflow.ts     workflow run/logs
src/cli/agent.ts        agent (ACP chat client)
src/cli/mcp.ts          MCP stdio server
src/cli/resolve.ts      resolveHost(), resolveSpaceId()
```

## Adding a Command

### 1. Implement in `src/cli/`

Use the pattern from `document.ts`:

```typescript
import { config } from "../config.ts";
import { resolveHost, resolveSpaceId } from "./resolve.ts";

async function resolveConnection() {
  const host = resolveHost();
  const token = config().CLI_ACCESS_TOKEN;
  const spaceId = await resolveSpaceId(host, token);
  return { host, token, spaceId };
}

export async function commandFoo(flags: { ... }): Promise<void> {
  const { host, token, spaceId } = await resolveConnection();
  // ...
}
```

### 2. Route in `vektor.ts`

Add a block in `main()`, import the function, and update `printUsage()` and the final `throw new Error(...)`.

### 3. Check the API route uses Bearer auth

API routes must use `authenticateJobTokenOrSpaceRole` (not `requireUser`) for CLI Bearer token access to work. `requireUser` only works for browser session auth.

```typescript
// Wrong — blocks CLI
const user = requireUser(context);

// Correct — works with VEKTOR_ACCESS_TOKEN
await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");
```

If you're adding commands for an area where the routes still use `requireUser`, update them first.

## Auth

The CLI authenticates with a Bearer token from `VEKTOR_ACCESS_TOKEN`. Never create job tokens locally — the server mints them when needed (like for agent sessions). The browser does the same thing.

```typescript
const token = config().CLI_ACCESS_TOKEN;
const headers = token ? { Authorization: `Bearer ${token}` } : {};
```

## MCP

`vektor mcp` runs the MCP server over stdio. MCP clients should launch the CLI directly instead of connecting to a Vektor HTTP endpoint:

```json
{
  "vektor": {
    "command": "vektor",
    "args": ["--space", "space_id", "mcp"],
    "env": {
      "VEKTOR_HOST": "http://localhost:8080",
      "VEKTOR_ACCESS_TOKEN": "at_..."
    }
  }
}
```

## Global Flags

`--space <id>` is stripped before routing and injected into `VEKTOR_SPACE_ID`. Any new global flag should be handled the same way with `stripFlag()`.

Do not add `--url`, `--space`, or `--token` to individual commands — they are env-var only.

The `space` commands are the exception to the HTTP-oriented command pattern:
they use `VEKTOR_DATABASE_URL` to update the auth database directly. A
positional URL is a space database being registered or attached, not the Vektor
server URL. It is sanitized before storage and inherits the auth token from
`VEKTOR_DATABASE_URL` when Vektor opens it.

## Output Format

Write to `process.stdout` directly. Use tab-separated columns for machine-readable output:

```
<id>\t<slug>\t<name>\n
```

This makes it easy to pipe into `awk`, `cut`, or scripts. Do not pretty-print unless a `--json` flag is explicitly added.

## Parsing Flags

The `parseFlags()` helper in `vektor.ts` handles `--key value` and `--flag` (boolean). It does not support repeated flags. If you need repeated values (e.g. `--rm key` multiple times), parse `rest` manually.

Positional arguments that contain `=` (like `key=value`) are passed through correctly as positionals.

## Writing Documents

### Markdown conversion happens server-side

`toHtmlIfMarkdown` in `src/utils/documentContent.ts` converts markdown to HTML when the document type is `markdown` or the `Content-Type` is a markdown MIME type.

Send `Content-Type: text/markdown` for raw markdown, or `Content-Type: application/json` with `{ type: "markdown", content: "..." }` to get conversion.

### Frontmatter is parsed CLI-side

`parseFrontmatter()` in `document.ts` strips `---` YAML frontmatter before sending content. Known fields (`title`, `slug`, `type`, `guid`, `created`, `modified`) map to first-class API fields; everything else goes into `properties`.

- `modified` → `updatedAt` in the DB
- `created` → `createdAt` in the DB
- `title` → stored as a document property (drives what the editor shows)

### Title inference

If no `title` frontmatter is present, `titleFromFilename()` derives a title from the source filename: strips the extension, converts `-` and `_` to spaces.

### Task lists

The marked renderer is configured globally in `documentContent.ts` to output TipTap-compatible task list HTML:

```html
<ul data-type="taskList">
  <li data-type="taskItem" data-checked="false">
    <label><input type="checkbox"><span></span></label>
    <div><p>text</p></div>
  </li>
</ul>
```

This structure must match exactly — the viewer renders stored HTML directly without going through TipTap's node views. If you change how task items are rendered, verify against what the editor produces on save.

The key pitfall: the regex that strips marked's injected `<input disabled="">` must only target `disabled=""` inputs. Stripping all `type="checkbox"` inputs will also destroy the `<label><input>` elements in nested task items.

## PATCH vs PUT for Documents

- `PUT /documents/:id` — replaces content (full body)
- `PATCH /documents/:id` — partial update: `properties`, `parentId`, `publishedRev`, or `readonly`
  - `properties` cannot be sent in the same request as `parentId`/`publishedRev`/`readonly`
  - Set a property to `null` to delete it

The `set` command makes two PATCH requests when both properties and parent are given.

## Uploading Files

`vektor upload <file>` uploads a local file to `/api/v1/spaces/:spaceId/uploads`.
It prints tab-separated `<key>\t<url>` by default, or the full upload response with `--json`.

```sh
vektor upload ./report.pdf
vektor upload ./report.pdf --document doc_123 --filename final-report.pdf
vektor upload ./data --filename data.csv --content-type text/csv --json
```

Options:

- `--filename <name>` overrides the uploaded filename used for extension validation and metadata.
- `--document <docId>` or `--document-id <docId>` associates the file with a document and triggers re-indexing.
- `--content-type <mime>` overrides Bun's MIME inference.
- `--json` prints `{ "url": "...", "key": "..." }`.

## Testing Without Rebuilding

Run from source during development:

```sh
bun ./vektor.ts <command>
```

After changes to server-side code (routes, `documentContent.ts`, etc.), restart the server:

```sh
kill <pid> && bun ./vektor.ts serve --no-auth
```

After CLI-side changes, `bun ./vektor.ts` picks them up immediately. Only rebuild the binary (`bun build --compile`) when distributing.
