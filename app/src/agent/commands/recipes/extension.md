---
title: Build and install an extension
keywords: extension, plugin, install, manifest, activate
---

## Rules — read first
- `frontend` entry runs on every page: register actions/suggestions only, no rendering
- `view` entry renders a full-page route: its `activate` MUST call `ctx.views.register(path, fn)` where `path` exactly matches the route path string in the manifest — any mismatch causes a runtime "no view registered" error
- Never call `activate` or `deactivate` yourself — the framework calls them and passes `ctx`
- Never use `ctx` outside of `activate`/`deactivate`
- If manifest has `routes`, it MUST also have a `view` entry (otherwise the route can never render)
- If manifest has a `view` entry, it MUST have `routes` (otherwise the view is never loaded)
- IDs: lowercase alphanumeric + hyphens only

## Manifest — actions/suggestions only (no page)
```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "...",
  "entries": { "frontend": "dist/main.js" }
}
```

## Manifest — with a full-page route
```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "1.0.0",
  "entries": {
    "frontend": "dist/main.js",
    "view": "dist/view.js"
  },
  "routes": [
    { "path": "my-ext", "title": "My Extension", "menuItem": { "title": "My Extension" } }
  ]
}
```

## Manifest — inline document view (Add Content menu)
Add `"document"` to a route's `placements` array to make it appear in the document Add Content menu. Users can then insert it as a block directly inside a document:
```json
{
  "id": "my-ext",
  "name": "My Extension",
  "version": "1.0.0",
  "entries": {
    "frontend": "dist/main.js",
    "view": "dist/view.js"
  },
  "routes": [
    {
      "path": "my-ext",
      "title": "My Extension",
      "description": "Show my extension inline",
      "menuItem": { "title": "My Extension" },
      "placements": ["document"]
    }
  ]
}
```
- `placements` defaults to `["page"]` (full-page sidebar only) when omitted
- Use `["page", "document"]` to appear in both places
- The view entry and `ctx.views.register` work exactly the same as for page routes — the framework handles embedding the rendered container as a document block

## ctx.collaboration — shared Yjs document
Available when a canvas or document is open; `null` otherwise. Always guard:
```js
export function activate(ctx) {
  if (!ctx.collaboration) return;
  const { ydoc, clientId } = ctx.collaboration;

  // Read/write synced state — visible to all peers in the room
  const yState = ydoc.getMap('game.mygame');
  yState.set('turn', 1);
  yState.observe(() => console.log('turn:', yState.get('turn')));
}
```
`clientId` is the Yjs numeric peer ID. There is no awareness object — use a YMap to track peers and share ephemeral state (cursors, presence):
```js
export function activate(ctx) {
  if (!ctx.collaboration) return;
  const { ydoc, clientId } = ctx.collaboration;

  // Each peer registers itself; others see the full set via observe
  const peers = ydoc.getMap('ext.mygame.peers');
  peers.set(String(clientId), { cursor: null });

  // Host election: peer with the lowest numeric clientId is the host
  function isHost() {
    const ids = [...peers.keys()].map(Number);
    return ids.length === 0 || Math.min(...ids) === clientId;
  }

  peers.observe(() => {
    console.log('host?', isHost());
  });

  return () => {
    // deactivate: remove self so others stop counting this peer
    peers.delete(String(clientId));
  };
}
```
Return a cleanup function from `activate` (or use `deactivate`) to remove the peer entry — otherwise stale entries remain until the ydoc is garbage-collected.

## ctx.api — wiki API client
Available inside `activate`/`deactivate` via `ctx.api` and `ctx.spaceId`:
```js
// List documents
const { documents } = await ctx.api.documents.get(ctx.spaceId, { limit: 100 });

// Get one document (returns DocumentWithProperties)
const doc = await ctx.api.document.get(ctx.spaceId, documentId);

// Create a document
const doc = await ctx.api.documents.post(ctx.spaceId, {
  title: 'My Doc', content: '<p>Hello</p>', type: 'document',
});

// Update document content (HTML)
await ctx.api.document.put(ctx.spaceId, documentId, '<p>Updated</p>');

// Patch metadata / properties
await ctx.api.document.patch(ctx.spaceId, documentId, {
  properties: { status: 'published' },
});

// Search
const { results } = await ctx.api.search.get(ctx.spaceId, { q: 'hello' });
```

## dist/main.js (frontend entry — always present)
```js
export function activate(ctx) {
  ctx.actions.register('my-ext.hello', {
    title: 'Say hello',
    run: async () => { alert('hello'); },
  });
}
export function deactivate(ctx) {
  ctx.actions.unregister('my-ext.hello');
}
```

## dist/view.js (view entry — only when manifest has "view" + "routes")
The path passed to `ctx.views.register` MUST be the same string as `routes[n].path` in the manifest:
```js
export function activate(ctx) {
  ctx.views.register('my-ext', (container) => {
    container.innerHTML = '<h1>My Extension</h1>';
    return () => { container.innerHTML = ''; }; // optional cleanup
  });
}
export function deactivate(ctx) {
  ctx.views.unregister('my-ext');
}
```

## Jobs
Add to manifest:
```json
"jobs": [{ "id": "my-job", "name": "My Job", "entry": "dist/job.js" }]
```
Job entry (dist/job.js) runs in worker_threads:
```js
const { parentPort } = require('worker_threads');
parentPort.postMessage({ type: 'result', success: true, outputs: { result: 'done' } });
```

## Build and install
Always zip from INSIDE the extension directory so manifest.json lands at the ZIP root:
```bash
cd my-ext
zip ../my-ext.zip .
zipinfo ../my-ext.zip   # verify: manifest.json must appear at the root, NOT under my-ext/
extension install ../my-ext.zip
```
Do NOT run `zip my-ext.zip my-ext/` from outside — manifest.json would be nested under my-ext/ and the install will fail with "missing manifest.json".

Run `zipinfo` after zipping and before installing. If manifest.json does not appear at the root of the listing, the zip is wrong — recreate it from inside the directory.

Only install when the user explicitly asks.
