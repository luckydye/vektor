---
title: Edit a JSON document with jq-style paths
keywords: edit, json, set, unset, push, path, jq
---

1. Read it first with `read_document`, or `get_current_document` for the current page.
2. Call `edit_document` with one or more operations. Paths are simplified jq paths:
   {"documentId":"<id>","operations":[{"op":"set","path":".config.timeout","value":30}]}
   {"documentId":"<id>","operations":[{"op":"set","path":".items[0].name","value":"Widget"}]}
   {"documentId":"<id>","operations":[{"op":"push","path":".items","value":{"name":"new entry"}}]}
   {"documentId":"<id>","operations":[{"op":"unset","path":".items[2]"}]}
Quoted keys work too: `.['weird key'].x`.
