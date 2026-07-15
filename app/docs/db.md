## Database storage

Vektor uses libSQL through `@libsql/client`. `VEKTOR_DATABASE_URL` points to the
auth database and its URL scheme selects the storage mode. When it is omitted,
Vektor uses `file:./data/auth.db` and keeps one database per space in
`data/spaces/`.

```sh
# Explicit local mode
VEKTOR_DATABASE_URL='file:./data/auth.db' vektor serve

# Hosted libSQL mode. Keep the URL quoted so the shell does not interpret `?`.
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' vektor serve
```

The auth database contains one `space_index` table. Each row represents a space
database and gains its space metadata when it is claimed; there is no separate
database-pool table. In local mode Vektor reconciles existing
`data/spaces/*.db` files into that index at startup, so existing installations
are discovered automatically.

Vektor does not provision hosted databases or depend on a provider API. Create
space databases externally, then register their credential-free libSQL URLs as
available capacity:

```sh
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space register 'libsql://space-001.example.com'

VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space ls
```

Creating a space claims one registered database. Space database connections
inherit the `authToken` from `VEKTOR_DATABASE_URL`; this requires one credential
that is valid for the auth database and every registered space database. Vektor
removes credentials from registered URLs before storing them. If no database is
available, space creation returns HTTP 503.

If initialization of a claimed database fails, Vektor marks that record
`disabled` so it cannot be handed to another space accidentally. After the
database has been recreated externally, return the empty database to the pool
with `vektor space enable <database-id>`. The same command recovers a record
left `claimed` when the Vektor process stopped during initialization: a database
that already contains space metadata is reactivated as that space, while a
partially initialized database without metadata must be recreated before it can
be enabled.

To attach a space database that already contains Vektor data (for example one
created by importing an existing `data/spaces/<space-id>.db`), use `attach`
instead. Vektor reads its `space_metadata` and preserves the existing space ID:

```sh
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space attach 'libsql://imported-space.example.com'
```

Deleting a hosted space marks its database record deleted and archives its
local uploads under `data/deleted/uploads/`. Database retention or removal
remains the external operator's responsibility. Uploaded files are separate
from libSQL and still require the `data/uploads` volume or a configured
object-storage adapter.
