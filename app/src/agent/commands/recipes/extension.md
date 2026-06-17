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
extension install ../my-ext.zip
```
Do NOT run `zip my-ext.zip my-ext/` from outside — manifest.json would be nested under my-ext/ and the install will fail with "missing manifest.json".

Only install when the user explicitly asks.
