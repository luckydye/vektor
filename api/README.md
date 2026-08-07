# @vektorapp/api

A zero-dependency, read-only TypeScript client for consuming Vektor content from a
website or server-rendered application.

```ts
import { createVektorClient } from "@vektorapp/api";

const vektor = createVektorClient({
  accessToken: process.env.VEKTOR_ACCESS_TOKEN,
});

// Uses http://localhost:8080 when baseUrl is omitted.
const page = await vektor.getDocumentBySlug("my-space-id", "about");
```

Available operations are `listSpaces`, `listDocuments`, `listDocumentsByCategories`,
`getDocument`, `getDocumentBySlug`, `getRevision`, `listCategories`, and `search`. The
client only issues GET requests. For a remote instance, pass `baseUrl` explicitly.

`getDocument` and `getDocumentBySlug` both accept an id or a slug, for the space and
the document alike. By default they return the published revision; pass
`{ draft: true }` to read the current draft instead, which requires an editor-scoped
token.

## Properties

A document property holds either one value or a list of them, so
`document.properties[key]` is typed `string | string[]`. Use the exported helpers
rather than assuming a string:

```ts
import { propertyScalar, propertyText } from "@vektorapp/api";

propertyText(document.properties.tags); // "docs, guide"
propertyScalar(document.properties.headerImage); // "https://…/hero.jpg"
```

Vektor returns document content as HTML. Only render it as raw HTML when the editors
of the source Vektor space are trusted.
