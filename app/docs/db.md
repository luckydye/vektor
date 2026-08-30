## Database storage

Vektor uses libSQL through `@libsql/client`. `VEKTOR_DATABASE_URL` points to the
auth database and its URL scheme selects the storage mode. When it is omitted,
Vektor uses `file:./data/auth.db` and keeps one database per space in
`data/spaces/`. `VEKTOR_DATA_DIR` moves both, for running more than one instance
from one working copy.

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
space databases externally, then register them as available capacity, each with
its own token:

```sh
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space register 'libsql://space-001.example.com' --token 'SPACE_001_TOKEN'

VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space ls
```

Creating a space claims one registered database. Vektor removes credentials from
registered URLs before storing them; the token is stored separately, encrypted
with `VEKTOR_SECRETS_ENCRYPTION_KEY`, and is used only for that one database. If no database is available, space creation returns
HTTP 503.

A token may also be given inside the registered URL — `vektor space register
'libsql://space-001.example.com?authToken=SPACE_001_TOKEN'` — which is captured
and encrypted the same way. Registering without either is refused: a token valid
for every database would make one leak readable across tenants, so
`VEKTOR_DATABASE_URL`'s own credential is never used for a space database. Scope
each token to its one database when you issue it.

### Schema migrations

Each space database records the highest migration it has applied in its own
`schema_migration` table, so opening one that is already current costs a single
version read rather than the whole schema. `src/db/client/migrations.ts` holds
the ordered list; because a database is stamped, adding a table to
`src/db/schema/space.ts` reaches new databases only — an existing one needs a
new entry appended with the next id.

A server migrates a space the first time it opens it. On a hosted deployment
that spreads the cost over the first request to each space and surfaces a bad
migration one space at a time, so roll a release's migrations out up front:

```sh
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space migrate            # every active space
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space migrate space_0f3c…
```

Each space prints `current`, `migrated` with the ids applied, or `error` with
the reason; one failure does not stop the rest, and the command exits non-zero
if any failed. Migrations are stamped one at a time, so a rerun after a failure
resumes at the one that failed.

### Rotating a space database token

Issue a new token with your provider, then store it. Vektor verifies the token
against the database before writing it and closes the cached connection, so the
next open uses the new one:

```sh
VEKTOR_DATABASE_URL='libsql://auth.example.com?authToken=TOKEN' \
  vektor space token database_0f3c… 'NEW_SPACE_TOKEN'
```

Revoke the old token afterwards, and restart the server: a process that already
has the space open keeps the old token on its cached connection. Rotating the auth database's own
credential is a `VEKTOR_DATABASE_URL` change and a restart.

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
  vektor space attach 'libsql://imported-space.example.com' --token 'IMPORTED_TOKEN'
```

`attach` requires `--token` (or a token in the URL) for the same reason.

Deleting a hosted space marks its database record deleted and archives its
local uploads under `data/deleted/uploads/`. Database retention or removal
remains the external operator's responsibility. Uploaded files are separate
from libSQL and still require the `data/uploads` volume or a configured
object-storage adapter.
