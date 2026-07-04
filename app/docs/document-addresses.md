# Vektor Document Addresses

Vektor document addresses are the canonical way to reference a document across
spaces and hosts. They replace passing separate `spaceId`, `documentId`, `host`,
and source URL fields through canvas and drag/drop flows.

## Address Format

```text
vektor+https://<host>/<spaceId>/<documentId>?href=<encoded document url>
vektor+http://<host>/<spaceId>/<documentId>?href=<encoded document url>
```

Example:

```text
vektor+https://vektor.example.com/space_123/doc_456?href=https%3A%2F%2Fvektor.example.com%2Fteam%2Fdoc%2Froadmap
```

Fields:

| Field | Description |
|---|---|
| `vektor+https:` / `vektor+http:` | Address scheme. The `vektor+` prefix distinguishes Vektor content addresses from normal browser URLs. |
| `host` | Origin host of the Vektor instance that owns the document. |
| `spaceId` | Stable space id on that host. |
| `documentId` | Stable document id inside the space. |
| `href` | Optional human-facing document URL. Used for opening remote documents in a browser and as a source URL hint. |

`spaceId` and `documentId` are URL path segments and must be percent-encoded when
created. Parsers must return `null` for malformed addresses, including malformed
percent-encoding.

## Why Addresses

A bare document id is only meaningful inside one space on one host. A Vektor
document address contains the complete identity needed to resolve the document:

- host origin
- space id
- document id
- optional human URL

Canvas document cards, document drag payloads, and cross-host embeds should use
the address as the primary identity and cache key.

## Direct Address Resolution

If code already has a Vektor document address, it should parse the address and
call the normal document API directly:

```text
GET <origin>/api/v1/spaces/<spaceId>/documents/<documentId>
```

For the example address above, the API request is:

```text
GET https://vektor.example.com/api/v1/spaces/space_123/documents/doc_456
```

The direct-address path does not require discovery. The address already contains
the origin and stable identifiers.

## Pasted HTTP URLs

When the user pastes a normal document URL, for example:

```text
https://vektor.example.com/team/doc/roadmap
```

the receiving Vektor instance does not yet know whether the URL points to a
Vektor host, or what stable ids correspond to the URL slugs. In that case it
uses discovery.

Discovery request:

```text
GET https://vektor.example.com/.well-known/vektor
```

Expected response:

```json
{
  "service": "vektor",
  "version": 1,
  "apiVersion": "v1",
  "documentEndpoint": "/api/v1/spaces/{spaceId}/documents/{documentId}"
}
```

The receiver derives a document API URL from the pasted path and endpoint
template. The current Vektor document route accepts either ids or slugs for the
space/document route parameters, so a pasted URL can resolve through the normal
document API:

```text
GET https://vektor.example.com/api/v1/spaces/team/documents/roadmap
```

The response returns the stable `space.id` and `document.id`; the receiver then
creates the canonical Vektor document address.

## Canvas Storage

Canvas document shapes store the canonical address:

```json
{
  "type": "document",
  "docAddress": "vektor+https://vektor.example.com/space_123/doc_456?href=..."
}
```

New canvas data should not store denormalized `docId` or `docSpaceId` fields.
Old snapshots may still contain those fields; readers may migrate them to
`docAddress` at load time, but writers should persist only `docAddress`.

## Drag And Drop

Document drag payloads use one MIME type:

```text
application/x-vektor-document-link
```

Payload:

```json
{
  "address": "vektor+https://vektor.example.com/space_123/doc_456?href=..."
}
```

The old id-only payload is deprecated and should not be emitted by new code. A
plain text URL may still be included as a browser-friendly fallback, but it is
not the canonical document identity.

## Access And CORS

Cross-host document embedding still uses the normal document authorization
rules. The remote document API decides whether the caller may read the document.
For unauthenticated cross-host fetches, this means the document must be readable
by the public group.

Document API `GET` responses include CORS headers so public cross-host reads can
be performed by the browser.

## Security Rules

Implementations must treat addresses and pasted URLs as untrusted input:

- Parse with `new URL(...)` and validate the scheme.
- Return `null` on malformed percent-encoding; do not let `decodeURIComponent`
  exceptions escape render, drop, or preview paths.
- For server-side fetches, validate URLs with the SSRF guard before fetching.
- Sanitize remote document HTML before rendering it in the local origin.
- Use the full address as the cache key; document ids alone are not globally
  unique.

## Implementation Pointers

- Address helpers: `app/src/utils/documentAddress.ts`
- Remote URL discovery: `app/src/api/routes/v1/url-metadata.ts`
- Canvas document references: `app/src/canvas/elements/documentLink.ts`
- Drag payload emitter: `app/src/editor/elements/page-target.ts`
