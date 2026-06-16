---
title: Edit a JSON document with jq-style paths
keywords: edit, json, set, unset, push, path, jq
---

1. Read it first: vektor read <id>
2. Operations (paths are simplified jq; values parsed as JSON, else taken as string):
   vektor edit <id> set .config.timeout 30
   vektor edit <id> set .items[0].name "Widget"
   vektor edit <id> push .items '{"name":"new entry"}'    # append to array
   vektor edit <id> unset .items[2]                       # remove element/key
Quoted keys work too: set '.["weird key"].x' 1
