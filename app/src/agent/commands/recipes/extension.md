---
title: Build and install an extension
keywords: extension, plugin, install, manifest, activate
---

ZIP layout: manifest.json at root + dist/ with plain ESM JS.
Minimum manifest:
   {
     "id": "timeline",
     "name": "Timeline",
     "version": "1.0.4",
     "description": "Visualize documents on a Gantt-style timeline using date properties",
     "entries": {
       "frontend": "dist/main.js",
       "view": "dist/view.js"
     },
     "routes": [
       {
         "path": "timeline",
         "title": "Timeline",
         "menuItem": { "title": "Timeline" }
       }
     ]
   }
IDs: lowercase alphanumeric + hyphens. Frontend entry exports activate(ctx)/deactivate(ctx);
ctx provides ctx.actions.register, ctx.suggestions.register, ctx.views.register, ctx.api.
Jobs: manifest "jobs":[{"id","name","entry","inputs","outputs"}]; entry uses worker_threads
and posts {type:"result",success:true,outputs:{...}}.
Install: zip the folder, then: extension install my-ext.zip
Only install extensions when the user explicitly asks.
