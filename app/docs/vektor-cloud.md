# Vektor Cloud

Vektor Cloud is a proprietary service that adds two things to the open-source
binary: **on-demand updates** and **cosmetics**. It works like skins in CS/Steam —
anyone can host their own vektor instance (like a dedicated server), but a
user's cosmetics are owned centrally and show up on every instance they join.

The service lives in a separate private repo. The open-source binary only ships
a thin client that talks to `VEKTOR_CLOUD_URL` (default `http://vektorapp.org/`).
If the service is unreachable or disabled, vektor behaves exactly as it does
today — nothing blocks.

## The model

- **The cloud is the authority on ownership.** Instances never store who owns
  what. They ask the cloud and trust the (signed) answer. This is the Steam
  inventory: the server renders the skin, Steam decides who owns it.
- **Identity is the verified email.** A user is the same person across instances
  because they log into each one with the same verified email. The cloud keys
  ownership on `sha256(email + salt)`, never the raw address.
- **Instances are untrusted dedicated servers.** A malicious host can only
  *display* a cosmetic locally; it cannot grant ownership or move money. Signed
  responses stop a host or middlebox from forging entitlements. That's the whole
  trust boundary — cosmetic-only, so it doesn't need to be Fort Knox.

## Cosmetics

A cosmetic is a purchasable visual. Most attach to a **user** and travel with
them across instances; one type attaches to a **space**.

Cosmetic types:

- **Canvas cursor & caret decorations / pets** — user-scoped. Decorates the
  user's live cursor and text caret on canvas and in documents; other
  collaborators see it via presence.
- **Canvas emotes** — user-scoped. Temporary reactions a user triggers on a
  canvas, broadcast to everyone in the room.
- **Stickers** — user-scoped. Placeable decals the user can drop onto canvas or
  documents; ownership gates which sticker packs they can use.
- **Avatar frames** — user-scoped. A frame/ring around the user's avatar,
  rendered anywhere the avatar appears.
- **Space themes** — **space-scoped**. Unlocked by an owning member's
  entitlement and applied to the whole space, so every member sees the theme
  regardless of who is present. This is the one type that attaches to a space
  rather than riding the presence payload.

User-scoped cosmetics travel with the user to every instance they join.
Space themes stay with the space they were applied to.

**Buying always happens on the cloud platform, never on a local instance.**
The store, Stripe Checkout, and payment live only on `vektorapp.org`. Instances
have no shop, no checkout, no payment code — they are read-only consumers of
ownership. This keeps every host out of the money path entirely, the same way a
CS dedicated server never sells you a skin; you buy on Steam and the server just
renders it.

Flow:

1. User buys a cosmetic on the cloud platform (`vektorapp.org`) → Stripe
   Checkout → webhook writes an entitlement for that email hash. No instance is
   involved.
2. When the user joins a collaboration room, the instance looks up their owned
   cosmetics from the cloud (cached) and injects them into the presence payload
   (`PresenceUser`) that vektor already broadcasts to everyone in the room.
3. Every other user's client renders the cosmetic from that broadcast. Because it
   rides existing presence, it appears live, on every instance, to everyone —
   with no shared database between instances.

Space themes are the exception to the presence flow: when a space loads, the
instance checks whether any owning member holds the theme entitlement and, if
so, applies it for all members — present or not.

Cosmetic assets are a **fixed whitelist of shapes/SVGs served from the cloud
CDN, selected by ID**. Instances never render arbitrary remote HTML/CSS — that
would be a cross-host XSS vector. The client validates every cosmetic ID against
the signed catalog before drawing it.

Cloud endpoints an instance calls (read-only):

- `GET /api/v1/cosmetics/catalog` — public list of products, previews, and
  immutable asset IDs, so a client can resolve and render an owned cosmetic.
- `GET /api/v1/cosmetics/owned?u=<email_hash>` — signed list of what a user owns.

Store and payment endpoints (cloud platform only, never called by an instance):

- `POST /api/v1/cosmetics/checkout` — starts a Stripe Checkout session.
- `POST /api/v1/stripe/webhook` — on payment, grants the entitlement.

An instance may deep-link a "Get more" button out to `vektorapp.org`, but the
purchase itself never touches the instance.

## Cosmetics — implementation

### Trust boundary (the load-bearing decision)

Presence today is client-authored: `useCollaboration.ts` builds the
`PresenceUser` in the browser and `presence.ts` `join()` stores `join.user`
verbatim, then broadcasts it. If cosmetics rode along in that client-sent
payload, anyone could forge a paid frame by editing their own presence.

So cosmetics are **stamped on the server, never trusted from the client.** At
presence join the server already knows the authenticated `userId`; it resolves
that user's verified email, looks up owned cosmetics from the cloud cache, and
overwrites `presence.user.cosmetics` before storing/broadcasting. The browser's
claimed cosmetics field is ignored. This is the single most important rule in
the feature.

### Cloud service (private repo)

Data model (Postgres):

- `products` — `id`, `type` (`cursor` | `emote` | `sticker` | `avatar_frame` |
  `space_theme`), `asset_id`, `name`, `price`, `active`, preview metadata.
- `entitlements` — `subject_hash` (`sha256(email + salt)`), `product_id`,
  `source`, `created_at`. This is the ownership table.
- `purchases` — Stripe session/payment records, for audit and refunds.

Endpoints (instance-facing, read-only):

- `GET /api/v1/cosmetics/catalog` — public. Products + immutable `asset_id`s +
  preview data. Long cache TTL.
- `GET /api/v1/cosmetics/owned?u=<subject_hash>` — returns the owned
  `product_id`s for that hash, **signed** (Ed25519) with an issued-at timestamp.

Endpoints (cloud storefront only, never called by an instance): `checkout`,
`stripe/webhook` as above.

Assets: each `asset_id` maps to an immutable, versioned file on the cloud CDN.
Assets are a **constrained descriptor format** (SVG shapes / sprite sheets /
theme token JSON) — never executable HTML/CSS/JS. The instance renders from a
fixed set of descriptor fields; anything outside the schema is dropped.

Signing: the cloud holds an Ed25519 private key; its public key is **pinned in
the vektor binary**. Every `owned` response is signed so a malicious host or
middlebox on the default HTTP endpoint cannot fabricate ownership.

### Instance client

New modules:

- `app/src/cloud/client.ts` — base URL (`VEKTOR_CLOUD_URL`), short timeouts,
  Ed25519 signature verification against the pinned key, fail-open on any error.
- `app/src/cloud/cosmetics.ts` — fetch + cache `catalog` and per-user `owned`;
  validate every `product_id`/`asset_id` against the signed catalog before use;
  expose `resolveUserCosmetics(email)` and `resolveSpaceTheme(spaceId)`.

New cache table (main SQLite DB, not per-space):

- `cloud_cosmetics_cache` — `subject_hash`, `payload` (signed blob), `fetched_at`,
  TTL. Serves as the offline fallback: stale-but-signed data still renders.

Identity resolution happens **server-side only**: the instance hashes the
authenticated user's verified email with the shared salt to form `subject_hash`.
Raw email never leaves the instance; the browser never sees another user's hash.

### Wiring into presence (user-scoped cosmetics)

1. Extend `PresenceUser` in `app/src/utils/realtime.ts`:
   `cosmetics?: { cursor?: string; frame?: string; emotePack?: string; stickerPack?: string }`
   (values are validated `product_id`s).
2. In `presence.ts` `join()`, after auth, call
   `resolveUserCosmetics(userEmail)` and set `presence.user.cosmetics` on the
   server side, discarding anything the client sent. Cached lookup, non-blocking:
   if the cloud is unreachable, cosmetics are simply absent.
3. Clients receive cosmetics in the existing presence snapshot/update broadcast —
   no new realtime message type.

### Space themes (space-scoped)

Stored, not broadcast. When a space loads, resolve the theme once:

- Add a space preference row (`preference` table in `db/schema/space.ts`), e.g.
  `key = "cloud_space_theme"`, `value = <product_id>`, set by a space owner who
  owns the theme entitlement (verified server-side at the moment they apply it).
- On space load, the server reads that preference, validates the applying owner
  still owns it (periodic revalidation, cached), and sends the theme token JSON
  to all members. Theme is CSS custom properties from the descriptor — a fixed
  token set, no arbitrary CSS.

### Rendering surfaces

- **Avatar frames** — `Avatar.vue` gains an optional `frame` prop; renders a
  whitelisted overlay ring around the existing avatar. Used everywhere avatars
  appear (presence stack, member lists, comments).
- **Cursor / caret decorations & pets** — `Canvas.vue` (and the document caret
  layer) render the remote user's `cosmetics.cursor` descriptor next to their
  live cursor position, driven by the presence state already sent on move.
- **Canvas emotes** — a new transient presence-state field (rides
  `updatePresence`), rendered as a short-lived animation at the emitting user's
  cursor for everyone in the room. Gated by owning the emote pack.
- **Stickers** — placeable canvas elements chosen from owned sticker packs; the
  sticker element stores only the `asset_id`, resolved to a CDN sprite on render.
- **Space theme** — applied as CSS custom properties on the space root from the
  resolved theme tokens.

### Local UI (no purchasing)

- A "Cosmetics" settings panel showing the user's owned items (from `owned`) and
  which are equipped, plus a "Get more" deep-link to `vektorapp.org`. Equipping
  is a local preference; ownership is authoritative from the cloud.
- A `GET /api/v1/users/me/cosmetics` instance route returns the current user's
  resolved owned + equipped set for that panel.

### What we need

- Cloud: private repo, Postgres, Stripe account + products, CDN bucket, Ed25519
  keypair (public key pinned into the binary), the endpoints above.
- Binary: `cloud/client.ts` + `cloud/cosmetics.ts`, the `cloud_cosmetics_cache`
  table, `PresenceUser` extension, server-side stamping in `presence.ts`, space
  preference for themes, and the render changes in `Avatar.vue` / `Canvas.vue` /
  caret layer, plus the settings panel and `users/me/cosmetics` route.
- Shared salt: a single global constant baked into the binary and the cloud so
  `subject_hash` lines up everywhere. It is a pepper (obfuscation of raw email),
  not a secret — any instance can compute any email's hash. That is acceptable
  because ownership is cosmetic-only and the `owned` response is signed, so a
  guessed hash still cannot forge ownership.

## Updates

Updates are **on demand only**. The binary never checks for updates on startup,
on a schedule, or in the background — a check happens only when an admin
explicitly asks for one. Nothing phones home unless triggered.

The cloud is the release authority. It reads the existing GitHub Releases and
adds channels (stable/beta), staged rollout, and a kill-switch/mandatory flag on
top.

- `GET /api/v1/update/check?version=&os=&arch=&channel=` → `{ latest, url, notes,
  mandatory }`, signed. Called only in response to an explicit check.
- An admin triggers a check from the settings UI (a "Check for updates" button)
  or via the `vektor update` CLI. If a newer version exists it is shown; there is
  no automatic banner polling.
- `vektor update` performs the check, then downloads the new binary, verifies a
  checksum from the signed response, atomically replaces itself, and restarts.
  The download itself is always over HTTPS (GitHub Releases) even though the API
  default is HTTP, so a tampered check response can't point the updater at a
  malicious binary.

## Configuration

- `VEKTOR_CLOUD_URL` — cloud base URL. Default `http://vektorapp.org/`.
- `VEKTOR_NO_COSMETICS=1` — disable the cosmetics client.

There is no env var for updates: they never run on their own, so there is
nothing to disable — a check happens only when an admin triggers one.

All cloud calls are best-effort with short timeouts and are cached locally; they
never block `serve` or rendering.
