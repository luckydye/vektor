# Permissions

Every read and write in Vektor is decided by one access-control list per space. A grant
in that list says: *this identity* holds *this role* on *this resource*. Nothing else
confers access — there is no admin flag, no ambient superuser, and no role that is
implied by having created something.

Three files carry the model. `src/acl/permissions.ts` holds the vocabulary and every
decision that can be made from a role alone, and is the one piece the browser also
imports, so the UI reaches the same verdict for the role the server handed it.
`src/acl/store.ts` resolves a grant out of the ACL table. `src/acl/guards.ts` enforces
it at the edge of a route, throwing a `401`/`403`/`404` response rather than returning a
verdict, so a route that forgets the failure path fails closed.

## Roles

`viewer` < `editor` < `owner`. A role is a floor, not a list: a check asks whether the
caller's role *meets* the level the action requires.

| Role | Reads | Writes documents | Configures the space |
| --- | --- | --- | --- |
| `viewer` | yes | no | no |
| `editor` | yes | yes | no |
| `owner` | yes | yes | yes |

"Configures the space" is the whole space-wide surface, and it is owner-only without
exception: rename and slug, delete, membership, access tokens, secrets, uploads, the AI
provider, integrations, feature grants, and a search rebuild.

Owner is only grantable on the space. It names authority over the space itself — its
configuration, its members, its existence — so on a single document or category it would
name nothing; asking for it there is a `400`, whoever asks. Below space scope the roles
are `viewer` and `editor`.

One identity can hold several grants on one resource — their own, plus one per group
they belong to. The strongest wins; a weaker grant never subtracts. So a viewer grant on
a document cannot hold back an editor grant inherited from the space.

## Features

Four capabilities are gated independently of role, so they can be handed out or withheld
without moving someone up or down the hierarchy:

| Feature | `viewer` | `editor` | `owner` |
| --- | --- | --- | --- |
| `comment` | – | yes | yes |
| `view_history` | – | yes | yes |
| `view_audit` | – | yes | yes |
| `manage_extensions` | – | – | yes |

The table is the default when no feature entry exists. An explicit entry wins over it in
both directions: a grant gives a viewer commenting, a deny takes history away from an
editor. Only an owner may write one.

## Scopes

A grant names a resource type from `ResourceType`:

- `space` — the whole space.
- `document` — one document.
- `document_tree` — a document and everything under it, however deep.
- `category` — every document in a category.
- `extension` — one extension; falls back to the space role when it has no entry.
- `feature` — the row shape used by feature grants and denies, not a place to share.

A document's role is resolved from all four paths at once — its own entry, a
`document_tree` entry on it or any ancestor, a `category` entry for a category it belongs
to, and the space entry — and the strongest of them decides. This is why a
tree-level share reaches a page created later, and why a space-wide `viewer` cannot
override a document-level `editor`.

## Who a grant names

- **A user** — by `userId`, or by `email` on the permissions endpoint, which resolves to
  an account (`404` when none exists).
- **A group** — by `groupId`. Groups come from the IdP's `wiki_groups` claim, sanitized
  against `GROUP_NAME_PATTERN` (`[A-Za-z0-9_.:-]{1,64}`) so a loose IdP cannot inject a
  privileged name. They are re-read periodically as well as at sign-in, so a group
  revoked upstream stops granting access without waiting for the next login.
- **`public`** — the synthetic group every caller carries, unauthenticated ones included.
  A grant to it is what makes a space, tree, category or document world-readable, and it
  is the only way an anonymous request gets past a guard. Write paths still require a
  real user, so `public: editor` reads as public *read* plus nothing.
- **An access token** — the identity `token:<tokenId>`, never a role of its own.

## Granting and revoking

`POST /spaces/:spaceId/permissions` is authorized on the privilege the write *moves*,
not on the action name, so the rules hold however the request is spelled — a demotion
phrased as a grant is still a withdrawal.

Owner is required for:

- writing an `owner` entry, at any scope;
- overwriting or removing an existing `owner` entry;
- any grant naming a `groupId`, at any scope, `public` included — admitting a class of
  people is space configuration, not a per-resource share;
- any grant at `space` scope, so membership sits beside renaming and deletion;
- withdrawing access anywhere other than `document` and `document_tree` scope;
- every `feature` grant, deny and revoke.

Editor is enough for the rest: sharing a `document`, `document_tree` or `category` with
an individual user, and taking a document or tree share back.

Granting `owner` anywhere but space scope is refused as malformed (`400`) before
authorization is considered, on this endpoint and on access-token resource grants alike.

Two invariants sit underneath all of it. A space always keeps at least one owner — the
write that would remove the last one is a `400`, whether it is a revoke or a demotion.
And no one can raise themselves: the caller's own role is read before the write, so a
grant is always evaluated against the privilege the caller already held.

## Access tokens

A token authenticates as `token:<tokenId>` and carries exactly the grants written for
that identity — a token is scoped by ACL entries, not by the role of the person who
created it. Creating and scoping tokens is owner-only.

A token stops working when its creator stops belonging to the space, so offboarding a
person also retires what they minted, without an owner having to find it.

## Archived documents

Archiving raises a document's bar to `editor`. Archive is the trash, so every
viewer-level grant that pointed at it — a public link included — stops resolving while
it sits there, and restoring brings those shares back with it. Nothing is revoked, so
nothing has to be rebuilt.

## Creating spaces

A space that does not exist yet has nothing to grant on, so this one gate is operator
configuration rather than ACL: `SPACE_CREATION_GROUPS`, a comma-separated allow list of
group ids. Unset, creation is open to every signed-in user. `public` is dropped from the
list rather than honoured — accepting it would make a configured allow list behave as if
it were absent.

## What the client knows

The browser cannot reach the ACL table. It receives its own resolved role and feature
flags from `GET /spaces/:spaceId/permissions/me` and calls the same `canView` / `canEdit`
/ `canAccessSettings` helpers the server uses, so a control the API would refuse is not
offered. That is presentation only: every one of those decisions is made again on the
server, and a request that skips the UI meets the same guard.

Authorization changes are pushed to live sessions rather than waiting for a reload, so a
revoked collaborator loses an open realtime document instead of keeping it until they
navigate.
