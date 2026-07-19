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
| `entries.view` | `string` | No | Path to view JS entry (custom pages) |
| `routes` | `array` | No | Custom view routes |

### Routes

Define custom pages your extension provides. Routes are accessible at `/:spaceSlug/x/:path`:

```json
{
  "routes": [
    { "path": "analytics", "title": "Analytics Dashboard" },
    { "path": "analytics/reports", "title": "Reports" }
  ]
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
import type { ExtensionContext } from "@vektorapp/app/src/utils/extensions";

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
      <div class="p-4">
        <h1 class="text-2xl font-bold">My Dashboard</h1>
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

Views are rendered when navigating to `/:spaceSlug/x/:routePath`. The extension is activated if not already loaded, then the registered view renderer is called.

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

Extension ui is isolated from the host application using a shadowDOM. Every view is responsible for its own styling.

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
import type { ExtensionContext } from "@vektorapp/app/src/utils/extensions";

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
import type { ExtensionContext } from "@vektorapp/app/src/utils/extensions";

export function activate({ views, api, spaceId }: ExtensionContext): void {
  views.register("analytics", async (container) => {
    const { documents } = await api.documents.get(spaceId);
    
    container.innerHTML = `
      <div class="p-6">
        <h1 class="text-3xl font-bold mb-4">Analytics</h1>
        <div class="grid grid-cols-3 gap-4">
          <div class="bg-background p-4 rounded-lg shadow">
            <p class="text-sm text-gray-600">Total Documents</p>
            <p class="text-2xl font-bold">${documents.length}</p>
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

## Building Extensions

Extensions should be bundled to JS files. Example `package.json`:

```json
{
  "name": "my-extension",
  "scripts": {
    "build": "esbuild src/main.ts --bundle --format=esm --outfile=dist/main.js && esbuild src/view.ts --bundle --format=esm --outfile=dist/view.js"
  },
  "devDependencies": {
    "esbuild": "^0.20.0"
  }
}
```

If you only have actions (no views), you only need `entries.frontend`. If you only have views (no actions), you only need `entries.view`.

## Packaging

Create a ZIP file containing:
- `manifest.json`
- `dist/main.js` (or whatever path specified in manifest entries)

Upload via the Vektor extensions management UI.

## Job Disk Cache

Jobs now have optional disk cache helpers available as a runtime global:

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

- Cache files are persisted under the system temp directory (`os.tmpdir()`).
- Cache scope is isolated per job id.
- Use `remember(...)` for cache-then-compute behavior.
