# CLI Development Guide

## Architecture

The CLI is a single Bun-compiled binary built from `vektor.ts`. All commands are routed through `main()` in that file. Command implementations live in `src/cli/`.

```
vektor.ts               routing, global flag parsing, help text
src/cli/document.ts     cat, write, set, ls, query
src/cli/category.ts     category ls/create/edit/rm
src/cli/space.ts        space register/attach/enable/token/ls (direct auth database access)
src/cli/upload.ts       upload
src/cli/workflow.ts     workflow run/logs
src/cli/agent.ts        agent (ACP chat client)
src/cli/mcp.ts          MCP stdio server
src/cli/resolve.ts      stored config file, resolveConfig(), resolveHost()
```

## Adding a Command

### 1. Implement in `src/cli/`

Use the pattern from `document.ts`:

```typescript
import { resolveConfig } from "./resolve.ts";

export async function commandFoo(flags: { ... }): Promise<void> {
  const { host, token, spaceId } = await resolveConfig();
  // ...
}
```

`resolveConfig()` is the only way in: it layers env vars over the stored config file and
discovers a space when none is configured. Call it once per command — the space lookup
can cost a request. `resolveHost()` is exported for `login`, which needs the host before
a space exists.

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

The CLI authenticates with a Bearer token. Never create job tokens locally — the server mints them when needed (like for agent sessions). The browser does the same thing.

```typescript
const { token } = await resolveConfig();
const headers = token ? { Authorization: `Bearer ${token}` } : {};
```

Never read `config().CLI_ACCESS_TOKEN` directly — `resolveConfig()` is what honors the
stored config file as well as the env var.

### Stored config

`vektor login` writes the space id and access token to
`$XDG_CONFIG_HOME/vektor/config.json` (`~/.config/vektor/config.json` by default), mode
`0600`. `vektor logout` deletes it.

```json
{
  "spaceId": "space_4f2b…",
  "accessToken": "at_9f1c…"
}
```

`VEKTOR_HOST` is the exception: `resolveHost()` reads the env var (or the localhost
default) and never the file, so the server URL stays a property of the shell, not of the
stored login. `vektor login` prints a reminder to keep the export when the host is not
the default.

Env vars win over the file, so `VEKTOR_ACCESS_TOKEN` in a shell profile keeps shadowing
a fresh `vektor login` — the command warns when that env var is set. Writes merge into
the existing file, and an unreadable or corrupt file is ignored rather than fatal.

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

Do not add `--url`, `--space`, or `--token` to individual commands — they come from the
stored config file and the env vars only.

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

`prepareDocumentContent` in `src/documents/content.ts` converts markdown to HTML when the submitted content type is a markdown MIME type.

`document create` sends JSON with `{ contentType: "text/markdown", content: "..." }`.
`document write` sends a raw body with `Content-Type: text/markdown`; the update API
does not read `contentType` from a JSON body.

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
