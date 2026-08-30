# Extension registry contract

An *extension store* is a read-only HTTP registry that a Vektor server fetches
packages from. **Anyone can run one** — it is three GETs over static JSON, with
no account, no API key and no registration with us. A server picks which one it
uses with `VEKTOR_MARKETPLACE_URL`; unset, it browses the store we publish at
`https://www.vektorapp.org`, which is a default, not a privileged position.

The contract is deliberately three plain GETs so a registry can be a static
build output (which is what ours is today) or a dynamic service, without either
side changing.

## Endpoints

All paths are relative to the registry base URL.

### `GET /api/extensions/v1/index.json`

The catalogue. One entry per extension, latest version only — enough to render a
browse/search UI without a request per extension.

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-30T10:00:00.000Z",
  "extensions": [
    {
      "id": "kanban",
      "name": "Kanban",
      "description": "Group records from a database document into kanban columns",
      "version": "1.1.33",
      "publisher": "vektor",
      "categories": ["databases", "views"],
      "keywords": ["kanban", "board"],
      "icon": "/api/extensions/v1/kanban/assets/icon.svg",
      "homepage": "https://github.com/luckydye/vektor",
      "repository": "https://github.com/luckydye/vektor",
      "license": "MIT",
      "capabilities": { "views": true, "jobs": false, "integrations": false },
      "downloadUrl": "/api/extensions/v1/kanban/1.1.33.zip",
      "size": 53889,
      "sha256": "…",
      "publishedAt": "2026-08-06T15:16:00.000Z",
      "detailUrl": "/api/extensions/v1/kanban.json"
    }
  ]
}
```

### `GET /api/extensions/v1/<id>.json`

One extension in full: short curated store copy, screenshots, and **every**
published version. `about` is written by the publisher for the listing — it is
deliberately not the package README, which is repo documentation (build steps,
file layout) and does not belong on a page someone is deciding from. `versions`
is ordered newest first and `latest` names the version a plain install resolves
to.

```json
{
  "schemaVersion": 1,
  "id": "kanban",
  "name": "Kanban",
  "latest": "1.1.33",
  "about": "…short markdown…",
  "versions": [
    {
      "version": "1.1.33",
      "downloadUrl": "/api/extensions/v1/kanban/1.1.33.zip",
      "size": 53889,
      "sha256": "…",
      "publishedAt": "…",
      "manifest": { "routes": [], "jobs": [], "integrations": [] }
    }
  ]
}
```

`manifest` carries only the parts a user should see before installing — what the
extension adds to their space. The authoritative manifest is the one inside the
package, which the server re-reads on install.

### `GET <downloadUrl>`

The package ZIP, byte-identical to what `vektor extension package` produced.

**Every URL in a registry document is a path relative to the registry**, never
an absolute one: a mirror serving the same files has to work unchanged, and it
would not if the origin the build ran under were baked in. A client resolves
them against the base URL it was configured with, and MUST refuse one that
resolves off that origin — which is what rejects an absolute URL injected into
`downloadUrl`.

## Client rules

A Vektor server installing from a registry:

1. resolves the version through `<id>.json` (never trusts a caller-supplied URL),
2. resolves `downloadUrl` against its configured base and downloads it,
   rejecting a URL or a redirect that leaves that origin,
3. caps the body at 5 MB — the same limit as a direct upload,
4. verifies `sha256` before the bytes reach the unzipper,
5. re-extracts and re-validates `manifest.json` from the package itself, and
6. stores it with `source: "marketplace"`, `sourceRef: "<id>@<version>"`,
   `sourcePublisher: "<publisher>"`.

The registry is a distribution channel, not a trust boundary: a package is only
as trustworthy as the registry serving it, and installing one still requires the
space-wide `manage_extensions` capability.
