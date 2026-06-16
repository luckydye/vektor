---
title: Create or update an HTML app document
keywords: app, iframe, html, application, widget
---

Type "app" documents are full HTML apps rendered in a sandboxed iframe.
Create: write complete HTML (inline CSS/JS) to a file, then:
   vektor create --title "My App" --type app app.html
Update (full rewrite is correct for apps):
   vektor update <id> app.html
For small fixes prefer line edits: vektor read <id>, then vektor edit <id> replace <n> ...
