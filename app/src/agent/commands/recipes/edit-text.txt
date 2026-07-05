---
title: Edit an HTML/text document by line numbers or regex
keywords: edit, html, text, line, insert, replace, delete, document, sub, regex, remove, sed
---

1. Read the live draft with `read_document`, or `get_current_document` for the current page.
2. Call `edit_document` with one or more operations. To remove or rewrite a pattern
   everywhere, use `sub` — do NOT round-trip through temp files or sed:
   {"op":"sub","pattern":"<user-mention[^>]*>.*?</user-mention>","replacement":""}
   {"op":"sub","pattern":"old phrase","replacement":"new phrase"}
   Patterns use JS regex with flags `gs`; the operation fails if nothing matched.
3. Line operations use 1-based lines and `$` for the end:
   {"op":"insert","line":"3","content":"<p>new paragraph</p>"}
   {"op":"replace","range":"2:4","content":"<p>replacement</p>"}
   {"op":"delete","range":"5"}
4. Re-read after each edit because line numbers shift.
Edits merge with concurrent changes from other users — never rewrite the whole
document with `write_document` unless replacing everything is the goal.
