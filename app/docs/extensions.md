# Vektor Extension API

This document describes the API surface available to Vektor extensions.

## Extension Structure

An extension requires a `manifest.json` and at least one entry point:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "Does something ripper",
  "entries": {
    "frontend": "dist/main.js",
    "view": "dist/view.js"
  },
  "routes": [
    {
      "path": "dashboard",
      "title": "My Dashboard",
      "menuItem": {
        "title": "Dashboard",
        "icon": "assets/dashboard.svg"
      }
    }
  ]
}
```

### Manifest Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique extension identifier |
| `name` | `string` | Yes | Display name |
| `version` | `string` | Yes | Semantic version |
| `description` | `string` | No | Short description |
| `entries.frontend` | `string` | No | Path to frontend JS entry (actions, etc.) |
| `entries.view` | `string` | No | Path to view JS entry (standalone views) |
| `routes` | `array` | No | Custom view routes |
| `jobs` | `array` | No | Sandboxed server-side jobs |
| `integrations` | `array` | No | OAuth providers the extension contributes |

### Routes

Define standalone views your extension provides. Routes are accessible at `/:spaceSlug/x/:path`:

```json
{
  "routes": [
    { "path": "analytics", "title": "Analytics Dashboard" },
    { "path": "analytics/reports", "title": "Reports" }
  ]
}
```

Set `placements` on a route to render it in additional locations. `"standalone"` is
the default, `"inline"` makes it available through the Add Content menu, and
`"document"` renders it beside standard documents on desktop. `"database"` adds
it to the database's **+ View** picker; after a user adds and selects it,
`ctx.documentId` is the current database document ID while the view is mounted.
`"page"` remains accepted as a deprecated alias for `"standalone"`.

For example, a Kanban view that is only available on databases uses one
placement:

```json
{
  "path": "kanban",
  "title": "Kanban",
  "placements": ["database"]
}
```

### Menu Items

Add a `menuItem` to a route to show it in the sidebar navigation:

```json
{
  "routes": [
    {
      "path": "analytics",
      "title": "Analytics Dashboard",
      "menuItem": {
        "title": "Analytics",
        "icon": "assets/analytics.svg"
      }
    },
    {
      "path": "analytics/reports",
      "title": "Reports"
    }
  ]
}
```

Only routes with `menuItem` defined appear in the navigation. The `icon` field is optional and accepts either inline SVG markup or a `.svg` file path within the extension package.

## Entry Point

Your frontend entry must export `activate` and optionally `deactivate` functions:

```ts
import type { ExtensionContext } from "@vektorapp/app/src/extensions/manager";

export function activate(ctx: ExtensionContext): void {
  // Set up your extension here
}

export function deactivate(ctx: ExtensionContext): void {
  // Clean up resources here (actions are auto-cleaned)
}
```

## ExtensionContext

The context object passed to `activate` and `deactivate`:

| Property | Type | Description |
|----------|------|-------------|
| `extensionId` | `string` | Your extension's ID |
| `spaceId` | `string` | Current space ID |
| `route` | `string \| null` | Current route path if rendering a view |
| `documentId` | `string \| null` | Current document ID for an embedded document/database view |
| `api` | `ApiClient` | Vektor API client |
| `actions` | `Actions` | Action registration |
| `views` | `Views` | View registration for custom routes |
| `suggestions` | `Suggestions` | Suggestion provider registration |
| `getActiveEditor()` | `() => Editor \| null` | Returns the active TipTap editor instance |
| `collaboration` | `{ ydoc: Y.Doc; clientId: number } \| null` | Active Yjs document and peer ID; null outside canvas/editor |

## Actions

Register commands that appear in the command palette:

```ts
export function activate({ actions }: ExtensionContext): void {
  actions.register("greet", {
    title: "Say G'day",
    description: "A friendly greeting",
    group: "extensions",
    run: async () => {
      alert("G'day mate!");
    },
  });
}

export function deactivate({ actions }: ExtensionContext): void {
  // Optional: actions registered via ctx.actions are auto-cleaned
  actions.unregister("greet");
}
```

### ActionOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `title` | `string` | No | Display name in command palette |
| `description` | `string` | No | Short description |
| `icon` | `() => string` | No | Icon renderer function |
| `group` | `string` | No | Group in command palette (default: "other") |
| `run` | `() => Promise<void>` | Yes | Function to execute |

Action IDs are automatically namespaced with your extension ID (e.g., `my-extension.greet`).

## Views

Views use a separate entry point (`entries.view`) from frontend actions (`entries.frontend`). This keeps your action code lightweight and loads view code only when needed.

Register view renderers for your custom routes:

```ts
// src/view.ts - loaded via entries.view
export function activate({ views }: ExtensionContext): void {
  views.register("dashboard", (container) => {
    // Render your view into the container element
    container.innerHTML = `
      <style>
        .dash { height: 100%; overflow-y: auto; padding: 24px;
                font-family: var(--font-sans, system-ui, sans-serif); }
        .dash h1 { font-size: var(--text-size-large, 17px); margin: 0 0 8px; }
      </style>
      <div class="dash">
        <h1>My Dashboard</h1>
        <p>G'day! This is a custom extension view.</p>
      </div>
    `;

    // Optionally return a cleanup function
    return () => {
      console.log("View unmounted");
    };
  });
}

export function deactivate({ views }: ExtensionContext): void {
  views.unregister("dashboard");
}
```

### View Render Function

The render function receives a container `HTMLElement` and can optionally return a cleanup function. Async renderers are supported:

```ts
type ViewRenderFn = (
  container: HTMLElement,
) => void | (() => void) | Promise<void | (() => void)>;
```

Views are rendered when navigating to `/:spaceSlug/x/:routePath` or when a host
placement such as `"inline"`, `"document"`, or `"database"` selects the route.
The extension is activated if not already loaded, then the registered view
renderer is called.

### Using a Framework

You can use any framework (Vue, React, etc.) to render views:

```ts
import { createApp } from "vue";
import DashboardView from "./DashboardView.vue";

export function activate({ views }: ExtensionContext): void {
  views.register("dashboard", (container) => {
    const app = createApp(DashboardView);
    app.mount(container);

    return () => {
      app.unmount();
    };
  });
}
```

### Styling

Views render inside a shadow root, so no app stylesheet reaches them: Tailwind
classes and app component CSS do not apply, and every view ships its own
`<style>` block inside the container.

CSS custom properties do inherit across that boundary, so use the app's design
tokens instead of hardcoded values — they are remapped for dark mode, and a
literal `#fff` background is a light-mode-only extension:

```css
color: var(--color-neutral-500, #6e6e6e);
background: var(--color-background, #fff);
border-radius: var(--radius-md, 8px);
font-family: var(--font-sans, system-ui, sans-serif);
```

| Group | Tokens |
|-------|--------|
| Text / UI colour | `--color-neutral-10` … `--color-neutral-950` (10 is white in light mode, inverted in dark) |
| Brand | `--color-primary`, `--color-primary-10` … `--color-primary-950`; primary action is `--color-primary-600` |
| Surfaces | `--color-background`, `--color-neutral-50` (sunken), `--color-neutral-100` (borders) |
| Type | `--font-sans`, `--text-size-small` (12px) … `--text-size-hero`, with matching `--line-height-*` |
| Space, radius | `--spacing-6xs` (2px) … `--spacing-5xl` (160px), `--radius-sm` (6px) … `--radius-2xl`, `--radius-full` |

The neutrals are the shell's own; the primary scale is generated per space from
the brand colour in its general settings. Take accents from `--color-primary-*`
and text, borders and surfaces from `--color-neutral-*`, and the view re-skins
itself per space and per theme for free.

Colours the app does not define — pass, warn, fail — are declared once as local
custom properties on your root element and reused. Check both themes with
`document.documentElement.dataset.theme = "dark"`.

#### The view scrolls itself

A standalone or database view is mounted into a 100%-height box inside an
`overflow: hidden` ancestor. The app never scrolls for you, so content past the
fold is clipped and the page looks frozen unless your root element is the scroll
container:

```css
.root {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain; /* don't chain to the app behind it */
  padding: 24px 24px 64px;
}

/* Max width on an inner wrapper, not on the scroll container, or the scrollbar
   ends up in the middle of a wide screen instead of at its edge. */
.root__page {
  max-width: 1480px;
  margin: 0 auto;
}
```

`height: 100%` degrades to `auto` where no ancestor constrains the height, so the
same rule is safe in the document column too.

## API Client

Access the Vektor API through `ctx.api`:

```ts
export function activate({ api, spaceId }: ExtensionContext): void {
  // Fetch documents in current space
  const { documents } = await api.documents.get(spaceId);

  // Other API methods available on api.*
}
```

## Editor Access

Get the active TipTap editor instance to manipulate document content:

```ts
export function activate({ actions, getActiveEditor }: ExtensionContext): void {
  actions.register("insert-greeting", {
    title: "Insert Greeting",
    run: async () => {
      const editor = getActiveEditor();
      if (!editor) {
        alert("No active editor!");
        return;
      }

      // Insert text at cursor
      editor.commands.insertContent("G'day mate!");
    },
  });
}
```

### Common Editor Operations

```ts
const editor = getActiveEditor();
if (!editor) return;

// Insert content at cursor position
editor.commands.insertContent("Hello world");

// Insert HTML content
editor.commands.insertContent("<strong>Bold text</strong>");

// Get current selection
const { from, to } = editor.state.selection;

// Get selected text
const selectedText = editor.state.doc.textBetween(from, to);

// Replace selection
editor.commands.insertContentAt({ from, to }, "Replacement text");

// Toggle formatting
editor.commands.toggleBold();
editor.commands.toggleItalic();
editor.commands.toggleStrike();

// Set heading
editor.commands.setHeading({ level: 2 });

// Insert a link
editor.commands.setLink({ href: "https://example.com" });

// Focus the editor
editor.commands.focus();

// Check if editor is editable
const canEdit = editor.isEditable;

// Get document as HTML
const html = editor.getHTML();

// Get document as JSON
const json = editor.getJSON();

// Get plain text
const text = editor.getText();
```

The editor is a [TipTap Editor](https://tiptap.dev/docs/editor/api/editor) instance. Refer to TipTap documentation for the full API.

## Suggestions

Register slash-command or trigger-character providers for the editor:

```ts
export function activate({ suggestions }: ExtensionContext): void {
  suggestions.register("my-ext.commands", {
    char: "/",
    items: async (query) => [
      { id: "heading", label: "Heading", description: "Insert a heading" },
      { id: "list", label: "Bullet List", description: "Insert a bullet list" },
    ].filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    onSelect: (item, editor) => {
      if (item.id === "heading") {
        editor.chain().focus().setHeading({ level: 1 }).run();
      } else if (item.id === "list") {
        editor.chain().focus().toggleBulletList().run();
      }
    },
  });
}

export function deactivate({ suggestions }: ExtensionContext): void {
  suggestions.unregister("my-ext.commands");
}
```

Providers are global — they activate in any editor that opens, not just the one active at registration time.

## Collaboration

When a canvas or document is open, `ctx.collaboration` provides access to the shared Yjs document:

```ts
export function activate({ collaboration }: ExtensionContext): void {
  if (!collaboration) return; // no document open yet

  const { ydoc, clientId } = collaboration;

  // Store synced state under a namespaced key
  const yState = ydoc.getMap("game.mygame");
  yState.set("score", 0);

  // Observe changes from any peer
  yState.observe(() => {
    console.log("score:", yState.get("score"));
  });
}
```

`collaboration` is `null` when no canvas or document is open. Always guard against it.

## Extension presence rooms

For live, non-document features such as a game, use an explicit extension
presence room. These rooms are ephemeral, scoped to the current space and
extension, and work from standalone routes. Vektor supplies the signed-in user's
profile and enforces extension access on the server.

```ts
export function activate(ctx: ExtensionContext): void {
  ctx.views.register("lobby", async (container) => {
    const room = await ctx.presence.connect("main", {
      state: { status: "ready" },
    });
    const unsubscribe = room.subscribe((event) => {
      // presence-snapshot, presence-update, or presence-leave
      console.log(event);
    });

    return () => { unsubscribe(); room.leave(); };
  });
}
```

Call `room.update(state)` to publish the latest local state. The room is not
persisted and must not be used as document storage.

### Leader election

`clientId` is the Yjs numeric peer ID. The peer with the lowest `clientId` among currently connected peers is a stable, self-healing host — if the host disconnects, the next-lowest peer takes over. Use this to assign one peer as the authority for writes that must not conflict (random events, turn advancement, etc.):

```ts
// In the view entry where you have access to awareness/presence
const connectedClientIds = getConnectedClientIds(); // from your own presence tracking
const isHost = clientId === Math.min(...connectedClientIds);
```

## Example Extension

### Actions Only

```ts
import type { ExtensionContext } from "@vektorapp/app/src/extensions/manager";

export function activate({ actions, api, spaceId, getActiveEditor, collaboration }: ExtensionContext): void {
  actions.register("word-count", {
    title: "Show Word Count",
    description: "Display document word count",
    group: "extensions",
    run: async () => {
      const editor = getActiveEditor();
      if (!editor) {
        alert("No document open");
        return;
      }

      const text = editor.getText();
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      alert(`Word count: ${words}`);
    },
  });

  actions.register("list-docs", {
    title: "List Documents",
    description: "Show all documents in space",
    group: "extensions",
    run: async () => {
      const { documents } = await api.documents.get(spaceId);
      const names = documents.map((d) => d.title).join("\n");
      alert(`Documents:\n${names}`);
    },
  });
}

export function deactivate(): void {
  // Actions auto-cleanup, nothing to do here
}
```

### With Custom View

```json
// manifest.json
{
  "id": "analytics",
  "name": "Analytics",
  "version": "1.0.0",
  "entries": {
    "frontend": "dist/main.js",
    "view": "dist/view.js"
  },
  "routes": [
    {
      "path": "analytics",
      "title": "Analytics",
      "menuItem": { "title": "Analytics" }
    }
  ]
}
```

```ts
// src/view.ts - separate entry for views
import type { ExtensionContext } from "@vektorapp/app/src/extensions/manager";

export function activate({ views, api, spaceId }: ExtensionContext): void {
  views.register("analytics", async (container) => {
    const { documents } = await api.documents.get(spaceId);
    
    container.innerHTML = `
      <style>
        .an { height: 100%; overflow-y: auto; padding: 24px;
              font-family: var(--font-sans, system-ui, sans-serif);
              color: var(--color-neutral-900, #141414); }
        .an__grid { display: grid; gap: 16px;
                    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
        .an__card { padding: 16px;
                    background: var(--color-background, #fff);
                    border: 1px solid var(--color-neutral-100, #e6e6e6);
                    border-radius: var(--radius-md, 8px); }
        .an__label { font-size: var(--text-size-small, 12px);
                     color: var(--color-neutral-500, #6e6e6e); }
      </style>
      <div class="an">
        <h1>Analytics</h1>
        <div class="an__grid">
          <div class="an__card">
            <p class="an__label">Total Documents</p>
            <p>${documents.length}</p>
          </div>
        </div>
      </div>
    `;
  });
}

export function deactivate({ views }: ExtensionContext): void {
  views.unregister("analytics");
}
```

## Conventions

None of this is enforced by the API. It is what makes an extension read as part
of the app rather than as an embedded foreign tool.

**Lifecycle.** Every `register` has a matching `unregister` in `deactivate`, and
the render function returns its teardown. Anything attached outside the container
— `window`/`document` listeners, observers, timers, intervals, object URLs,
subscriptions — is removed there; DOM inside the container is thrown away for you.
For live updates use `api.subscribeToTopics(...)` with a debounced refresh rather
than polling.

**Dependencies.** Default to none. The platform covers more than people expect:
`DecompressionStream`, `DOMParser`, `ResizeObserver`, `IntersectionObserver`,
`structuredClone`, `Intl`, `crypto.randomUUID`. Add a dependency only when the
alternative is hundreds of lines of error-prone code — a PDF parser, a spreadsheet
reader — and keep it in the extension's own `package.json`.

**Rendering.** Build the static shell once as a template string, assign it with
`container.innerHTML`, then keep references to the parts that change and repaint
those in place; a full re-render on every state change loses scroll position,
focus and iframe state. Never interpolate data into an HTML string — file names,
document titles and error messages go in via `textContent`.

**Robustness.** One bad input must not take down the view: process items in a loop
with `try`/`catch` per item and render the failure as its own card with the reason
in it. Wrap `localStorage` access in `try`/`catch`, since private mode throws.
Never fail silently — if something was skipped, say so in the status line. Empty,
loading and error states are part of the design; every view needs all three.

**Untrusted content.** Render uploaded files and third-party HTML in an iframe
with `srcdoc` and `sandbox="allow-scripts allow-modals allow-pointer-lock"`. Never
add `allow-same-origin` to a sandbox that also has `allow-scripts` — together they
hand the content the app's origin. The frame inherits the app's CSP, which breaks
two assumptions people bring from a local test page: `connect-src` has no `data:`,
so a `fetch` rewritten to a `data:` URI is blocked, and `script-src` has no
`'unsafe-eval'`, so `eval` and `new Function` throw. Both are silent failures
outside the app, so test embedded content behind the same headers.

**Persisted state.** Small preferences go to `localStorage` under
`"<extension-id>:<key>"`. Anything a colleague should also see belongs in the
space: a database document, or a `_`-prefixed JSON property on a document (keys
starting with `_` are hidden in the UI).

## Building and Packaging

The CLI scaffolds, builds and uploads. All three take the extension id, and
`package` and `upload` default to the current folder when you leave it out:

```bash
vektor extension create  <extension-id>   # scaffolds the folder
vektor extension package <extension-id>   # runs the build, bumps the version, zips
vektor extension upload  <extension-id>   # uploads the zip to a space
```

`upload` takes its token and space from whatever `vektor login` stored in
`~/.config/vektor/config.json`, both overridable per-run with `VEKTOR_ACCESS_TOKEN`
(required) and `VEKTOR_SPACE_ID` (otherwise the first space you can see). The server
comes from `VEKTOR_HOST` alone and defaults to localhost. A zip can also be uploaded
through the extensions management UI.

The build is one line in `package.json` and needs no bundler config:

```json
{
  "name": "my-extension",
  "scripts": {
    "build": "bun build src/view.ts --outdir dist --format esm --target browser"
  }
}
```

`bun build` follows imports, so splitting a view into modules costs nothing — do
it once `view.ts` passes a few hundred lines. Add `src/main.ts` to the command
only when the extension has a frontend entry: if you only have actions you need
`entries.frontend`, if you only have views you need `entries.view`.

`create` writes to `extensions/<extension-id>` relative to the current directory.
`package` bumps the patch version in the manifest, runs the build script, and
zips `manifest.json`, everything under `dist/`, and the files sitting beside them
— other subdirectories are not included, so referenced assets belong in `dist/`.

### Before you package

- `tsc` clean under strict and `noUncheckedIndexedAccess`, Biome check clean
- `activate` registers, `deactivate` unregisters, render returns a teardown, and
  no listener, observer or timer survives it
- No hardcoded colours; light and dark both checked
- The view scrolls inside itself — check with more content than fits a screen
- Empty, loading, error and "one item failed" states all render
- User-supplied strings go in via `textContent`; untrusted markup is sandboxed
- Keyboard reachable, `aria-live` on the status line, truncated text has `title`
- Tried against real input, not only a happy-path fixture

## Jobs

A job is a bundled JavaScript file that runs inside Vektor's sandboxed JS VM —
not in Node. It gets its arguments from the `input` global and declares its
result by calling `output()`:

```ts
// src/jobs/word-count.ts
const { documentId } = input as { documentId: string };
if (!documentId) throw new Error("Missing required input: documentId");

const content = await readDocument(documentId);
log(`Read ${content.length} bytes`);

await output({
  words: { type: "text", value: String(content.trim().split(/\s+/).length) },
});
```

Throwing fails the job; the message lands in the run log. Ambient types for
every global are in `extensions/job-runtime.d.ts`.

### What a job can do

There is no `require`, no `node:*` module, no filesystem and no network beyond
the globals below. A capability that is not granted does not exist, so the way
to add one is to add it to the host's capability table — not to import it.

| Capability | Purpose |
| --- | --- |
| `input`, `output()`, `log()` | Arguments, result, run log |
| `readDocument`, `writeDocument`, `createDocument`, `searchDocuments` | Space documents |
| `uploadArtifact` | Persist a file and get a permanent URL |
| `getSecret` | Space secrets |
| `fetch` | The public internet. Loopback and private ranges are refused |
| `apiFetch` | This instance's own API, authenticated as the run |
| `agentPrompt` | One ACP agent turn, with progress streamed to the log |
| `zip`, `spreadsheet`, `hash` | Archive, spreadsheet and digest helpers, run natively |
| `scratch`, `exec` | A private directory, and the allowlisted conversion tools |
| `jobCache` | Disk cache, isolated per job id |
| `sleep`, `setTimeout` | Timers |

Prefer the native helpers over bundling a library: `spreadsheet.toRows()` reads
XLSX and CSV, while `zip.read()` handles archives, without shipping a large
JavaScript parser to be run by an interpreter.

`exec` accepts only `pandoc`, `htmlq` and `rsvg-convert` — never a path — and
runs without a shell, with the scratch directory as the working directory. Arguments are
confined to that directory too: an absolute path, a `..` escape or anything the
URL parser reads as a location (`file:///etc/passwd`, `smb://host/share`) is
refused, so inputs and outputs must be named relative to the working directory.

### Bundling

Jobs are evaluated as scripts, so a bundle must contain no `import` or `export`
statements — inline every dependency and let the build strip the trailing export
block (see `extensions/extensions/workflow-builder/build.ts`). Because a script
has no top-level `return`, results go through `output()`.

### Job Disk Cache

```ts
declare const jobCache: {
  get: (key: string) => Promise<{ hit: boolean; value: unknown }>;
  set: (key: string, value: unknown, options?: { ttlMs?: number }) => Promise<void>;
  delete: (key: string) => Promise<void>;
  remember: <T>(
    key: string,
    produce: () => Promise<T>,
    options?: { ttlMs?: number },
  ) => Promise<T>;
};
```

- Cache files are persisted under the system temp directory.
- Cache scope is isolated per job id.
- Use `remember(...)` for cache-then-compute behavior.

### Testing jobs

Job globals do not exist under `bun test`. The workflow-builder extension
preloads `test-setup.ts`, which installs equivalents backed by real libraries, so
helpers can be unit-tested directly; copy that pattern for other extensions.

## Integrations (OAuth)

OAuth providers are not built into Vektor — an extension declares them, and the
server runs the flow, stores the encrypted tokens, and proxies API calls. The
manifest describes the provider; it never contains credentials.

```json
{
  "id": "gitlab",
  "name": "GitLab",
  "version": "1.0.0",
  "entries": {},
  "integrations": [
    {
      "id": "gitlab",
      "label": "GitLab",
      "description": "Connect GitLab to work with your projects and issues.",
      "authorizationUrl": "{instance}/oauth/authorize",
      "tokenUrl": "{instance}/oauth/token",
      "userInfoUrl": "{instance}/api/v4/user",
      "scopes": ["api"],
      "defaultInstanceUrl": "https://gitlab.com",
      "apiBasePath": "/api/v4",
      "profile": { "accountId": ["id"], "username": ["username", "name"] }
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Provider id; lowercase alphanumeric and hyphens. Appears in every `/integrations/:provider` route |
| `label` | Yes | Shown on the settings card |
| `authorizationUrl`, `tokenUrl`, `userInfoUrl` | Yes | Endpoints. `{instance}` is replaced with the configured instance URL |
| `scopes` | No | Requested scopes, unless the operator overrides them |
| `defaultInstanceUrl` | No | Used when the operator configures none — set it for a hosted-only service |
| `apiBasePath` | No | Proxied requests are confined to this path and prefixed with it |
| `profile` | Yes | Which userinfo fields hold the account id and display name, tried in order |
| `agent` | No | `instructions` for the agent's system prompt, and a `command` naming a job in `jobs` |

Credentials come from the environment, named after the provider id: for `gitlab`,
`VEKTOR_OAUTH_GITLAB_CLIENT_ID`, `VEKTOR_OAUTH_GITLAB_CLIENT_SECRET`, and
optionally `VEKTOR_OAUTH_GITLAB_BASE_URL` and `VEKTOR_OAUTH_GITLAB_SCOPES`. A
provider whose id contains hyphens uses underscores in the variable name. Until
both id and secret are set the settings card shows the provider as unconfigured
and lists what is missing.

### Agent commands

`agent.command` gives the AI agent a shell command backed by one of the
extension's jobs. The job receives `input.args` (the argument list) and
`input.provider`, and returns `stdout`, `stderr` and `exitCode` text outputs. It
reaches the provider through the integration proxy — the OAuth token stays on
the server:

```js
const response = await apiFetch(
  `/api/v1/spaces/${input.spaceId}/integrations/${input.provider}/proxy`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "GET", path: "/user" }),
  },
);
```

The command is registered only for users who have that provider connected, as
are the `agent.instructions` appended to the system prompt.
