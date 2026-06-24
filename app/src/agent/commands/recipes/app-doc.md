---
title: Create or update an HTML app document
keywords: app, iframe, html, application, widget
---

Type "app" documents are full HTML apps rendered in a sandboxed iframe.
Create with `write_document`: pass the complete HTML (inline CSS/JS), title, and type `app`.
For a full rewrite, call `write_document` with the document ID and complete HTML.
For small fixes, read with `read_document`, then use `edit_document` line operations.
