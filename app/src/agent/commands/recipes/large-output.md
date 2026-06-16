---
title: Handle output too large for one tool result
keywords: large, output, truncated, pagination, jq, file
---

Tool output is capped at ~6000 chars. When truncated:
   command > out.json && jq '.items | length' out.json   # process from a file
For paginated APIs, loop pages and append to a file; stop when a page is empty.
Read large files in slices: sed -n '100,160p' out.json
