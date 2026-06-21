# @vektor/api

A zero-dependency, read-only TypeScript client for consuming Vektor content from a
website or server-rendered application.

```ts
import { createVektorClient } from "@vektor/api";

const vektor = createVektorClient({
  accessToken: process.env.VEKTOR_ACCESS_TOKEN,
});

// Uses http://localhost:8080 when baseUrl is omitted.
const page = await vektor.getDocumentBySlug("my-space-id", "about");
```

Available operations are `listDocuments`, `listDocumentsByCategories`,
`getDocument`, `getDocumentBySlug`, `listCategories`, and `search`. The client only
issues GET requests. For a remote instance, pass `baseUrl` explicitly.

Vektor returns document content as HTML. Only render it as raw HTML when the editors
of the source Vektor space are trusted.
