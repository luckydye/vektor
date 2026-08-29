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
src/cli/login.ts        login (browser and --ssh), logout
src/cli/sshAgent.ts     ssh-agent client and ssh-keygen fallback
src/cli/request.ts      credential resolution, apiFetch(), resolveConfig()
src/cli/resolve.ts      stored config file, resolveHost()
```

## Adding a Command

### 1. Implement in `src/cli/`

Use the pattern from `document.ts`:

```typescript
import { apiFetch, resolveConfig } from "./request.ts";

export async function commandFoo(flags: { ... }): Promise<void> {
  const { host, spaceId } = await resolveConfig();
  // ...
}
```

`resolveConfig()` (in `request.ts`) is the only way in: it layers env vars over the
stored config file and discovers a space when none is configured. Call it once per
command — the space lookup can cost a request. `resolveHost()` is exported for
`login`, which needs the host before a space exists.

Requests go through `apiFetch()` from the same module, which attaches whatever
credential this machine has. Never build the header at a call site: a token is one
line, but an SSH key signs each request individually and only `apiFetch` knows how.

### 2. Route in `vektor.ts`

Add a block in `main()`, import the function, and update `printUsage()` and the final `throw new Error(...)`.

### 3. Check what the API route accepts

A route reached with `VEKTOR_ACCESS_TOKEN` must use `authenticateJobTokenOrSpaceRole`
(not `requireUser`): a token is not a session, and `requireUser` only sees sessions.

```typescript
// Wrong — blocks a token-authenticated CLI
const user = requireUser(context);

// Correct — works with VEKTOR_ACCESS_TOKEN
await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");
```

A signature resolves to a real user, so `requireUser` accepts it either way. Only
`requireSessionUser` refuses one, and that is reserved for endpoints where a key must
not answer for its owner — registering another SSH key above all.

If you're adding commands for an area where the routes still use `requireUser`, update
them first.

## Auth

The CLI has two credentials and picks the first it finds: an access token
(`VEKTOR_ACCESS_TOKEN`, or one stored by the browser login) or an SSH key, which signs
each request as it goes out. Never create job tokens locally — the server mints them
when needed (like for agent sessions). The browser does the same thing.

```typescript
const { host, spaceId } = await resolveConfig();
const response = await apiFetch(`${host}/api/v1/spaces/${spaceId}/documents`);
```

Never read `config().CLI_ACCESS_TOKEN` directly — `resolveCredential()` is what honors
the stored config file, the env var, and the SSH key in that order.

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

An SSH login writes no token — only the key it chose:

```json
{
  "spaceId": "space_4f2b…",
  "sshKey": "SHA256:2f8c…"
}
```

`VEKTOR_HOST` is the exception: `resolveHost()` reads the env var (or the localhost
default) and never the file, so the server URL stays a property of the shell, not of the
stored login. `vektor login` prints a reminder to keep the export when the host is not
the default.

Env vars win over the file, so `VEKTOR_ACCESS_TOKEN` in a shell profile keeps shadowing
a fresh `vektor login` — the command warns when that env var is set. Writes merge into
the existing file, and an unreadable or corrupt file is ignored rather than fatal.

### SSH login

`vektor login --ssh` is for machines with no browser to open — servers,
containers, CI. It does not fetch a token: with an SSH key configured the CLI
signs **every request** with it, so nothing standing is stored on the machine.

```sh
vektor login --ssh                       # picks the ssh-agent identity the server knows
vektor login --ssh --key ~/.ssh/id_work  # one specific key
```

The key has to be registered first, under user settings → Access Tokens → SSH
Keys (`POST /api/v1/users/ssh-keys`). Registration needs a browser session and
takes no other credential: a key authenticates every space its owner can reach,
so a signature must not be able to add another one.

`login --ssh` only settles *which* key — the agent may hold several and the
server knows some of them — by signing a request to `/api/v1/users/me` with each
in turn. What it writes to the config file is a fingerprint and a space id,
neither of them secret; a token left there by an earlier browser login is
removed.

#### What a signature covers

`src/utils/sshRequestSignature.ts` defines the scheme; both sides build the
string from it, which is what makes them agree.

```
VEKTOR-SSH-V1
POST
/api/v1/spaces/space_4f2b/documents?draft=1
<sha256 of the body, hex>
<unix seconds>
<nonce>
```

Signed as SSHSIG under namespace `vektor-cli` and sent as one header:

```
Authorization: SSH-SIG t=1756500000,n=<nonce>,s=<base64 of the armored signature>
```

So a captured signature is worth the one request it was made for: another path,
another body, or a second use of the same nonce all fail. The server accepts a
five-minute clock skew and remembers spent nonces for that long.

`src/api/sshRequestAuth.ts` verifies it in `hydrateRequestContext` and resolves
the fingerprint to a user. From there the request is authorized exactly as a
browser session's is — the key carries an identity, never permissions of its
own, so a signed CLI call reaches what the person reaches and no more.

`session` stays null for a signed request. That difference is the one thing
routes may read: `requireSessionUser` (used by the SSH key endpoints) refuses a
signature where `requireUser` accepts it.

Supported key types: `ssh-ed25519`, `ssh-rsa` (2048 bits or more, SHA-2
signatures only) and `ecdsa-sha2-nistp256/384/521`. The formats are parsed in
`src/utils/sshKeys.ts` — the server never shells out to `ssh-keygen`, which
keeps the single binary self-contained.

Signing costs one ssh-agent round trip per request. Without an agent the CLI
falls back to `ssh-keygen -Y sign` on a key file, which prompts for a passphrase
every time — use an agent for anything chatty, `vektor mcp` above all.

Deleting a key takes effect on the next request; there is no token left over to
revoke.

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
