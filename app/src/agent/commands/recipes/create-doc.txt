---
title: Create a new document
keywords: create, new, document, page, title, parent
---

Call `write_document` without a document ID. Pass HTML or Markdown in `content`:
   {"title":"Notes","content":"<h1>Notes</h1><p>...</p>"}
   {"title":"Child page","parentId":"<parent-document-id>","content":"..."}
   {"title":"My App","type":"app","content":"<!doctype html>..."}
The result contains the new document ID and metadata.
