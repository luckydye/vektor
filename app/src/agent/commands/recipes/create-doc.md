---
title: Create a new document
keywords: create, new, document, page, title, parent
---

Content comes from a file or stdin (HTML or Markdown):
   echo "<h1>Notes</h1><p>...</p>" | vektor create --title "Notes"
   vektor create --title "Child page" --parent <parent-document-id> page.html
   vektor create --title "My App" --type app app.html     # sandboxed HTML app
The result prints the new document id. Use --json for full metadata.
