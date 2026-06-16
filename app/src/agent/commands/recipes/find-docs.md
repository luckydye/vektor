---
title: Find and read documents
keywords: search, find, list, read, lookup
---

   vektor list --json                       # all documents (id, title, type)
   vektor search "quarterly report" --json  # full-text search -> take id
   vektor read <id>                         # returns live draft content
   vektor read <id> > doc.html              # save to a virtual file
"this document"/"the page" means: vektor current
