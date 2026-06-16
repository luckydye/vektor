---
title: Edit an HTML/text document by line numbers or regex
keywords: edit, html, text, line, insert, replace, delete, document, sub, regex, remove, sed
---

1. Read the document with line numbers (returns the live draft, one block per line):
   vektor read <id> -n        # or: vektor current -n
2. To remove or rewrite a pattern everywhere, use sub — do NOT round-trip through
   temp files or sed (that corrupts unicode):
   vektor edit <id> sub '<user-mention[^>]*>.*?</user-mention>' ''   # remove all mentions
   vektor edit <id> sub 'old phrase' 'new phrase'                    # plain text works too
   (JS regex, flags gs; the command fails if nothing matched)
3. Line operations, one per call (1-based lines, $ = end):
   vektor edit <id> insert 3 --content '<p>new paragraph</p>'   # insert before line 3
   vektor edit <id> replace 2:4 --content '<p>replacement</p>'  # replace lines 2-4
   vektor edit <id> delete 5                                    # delete line 5
4. Longer content can come from a file (vektor edit <id> replace 2 fix.html) or stdin.
5. Re-read with -n after each edit — line numbers shift.
Edits merge with concurrent changes from other users — never rewrite the whole
document with 'vektor update' unless replacing everything is the goal.
