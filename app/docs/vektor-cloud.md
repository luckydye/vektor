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
