| Route | Method | anonymous | outsider | viewer | editor | owner | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/.well-known/caldav` | GET | 401 | 401 | 401 | 401 | 401 | public — service discovery, no space data |
| `/.well-known/caldav` | POST | 401 | 401 | 401 | 401 | 401 | public — service discovery, no space data |
| `/.well-known/caldav` | PROPFIND | 401 | 401 | 401 | 401 | 401 | public — service discovery, no space data |
| `/.well-known/vektor` | GET | 200 | 200 | 200 | 200 | 200 | public — service discovery, no space data |
| `/.well-known/vektor` | OPTIONS | 204 | 204 | 204 | 204 | 204 | public — service discovery, no space data |
| `/api/auth/[...all]` | GET | 404 | 404 | 404 | 404 | 404 | public — better-auth: sign-in/sign-up must be reachable |
| `/api/auth/[...all]` | POST | 404 | 404 | 404 | 404 | 404 | public — better-auth: sign-in/sign-up must be reachable |
| `/api/auth/[...all]` | PROPFIND | 404 | 404 | 404 | 404 | 404 | public — better-auth: sign-in/sign-up must be reachable |
| `/api/caldav/calendars/[userId]` | GET | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]` | POST | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]` | PROPFIND | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]/[spaceId]` | GET | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]/[spaceId]` | POST | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]/[spaceId]` | PROPFIND | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]/[spaceId]/[eventId]` | GET | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/calendars/[userId]/[spaceId]/[eventId]` | OPTIONS | 204 | 204 | 204 | 204 | 204 |  |
| `/api/caldav/calendars/[userId]/[spaceId]/[eventId]` | PUT | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/principals/[userId]` | GET | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/principals/[userId]` | POST | 401 | 403 | 403 | 403 | 403 |  |
| `/api/caldav/principals/[userId]` | PROPFIND | 401 | 403 | 403 | 403 | 403 |  |
| `/api/v1/access-tokens` | GET | 401 | 200 | 200 | 200 | 200 | caller-scoped — the caller's own tokens, in the spaces it belongs to |
| `/api/v1/access-tokens` | POST | 401 | 400 | 400 | 400 | 400 | caller-scoped — the caller's own tokens, in the spaces it belongs to |
| `/api/v1/access-tokens/[tokenId]` | DELETE | 401 | 404 | 404 | 404 | 404 | caller-scoped — reaches only a token the caller issued |
| `/api/v1/access-tokens/[tokenId]` | PATCH | 401 | 404 | 404 | 404 | 404 | caller-scoped — reaches only a token the caller issued |
| `/api/v1/auth/cli` | GET | 401 | 400 | 400 | 400 | 400 | public — CLI pairing: authenticated by the one-time code it mints |
| `/api/v1/auth/cli` | POST | 401 | 400 | 400 | 400 | 400 | public — CLI pairing: authenticated by the one-time code it mints |
| `/api/v1/auth/cli/token` | POST | 400 | 400 | 400 | 400 | 400 | public — CLI pairing: authenticated by the one-time code |
| `/api/v1/chat/acp` | POST | 400 | 400 | 400 | 400 | 400 |  |
| `/api/v1/chat/completions` | POST | 400 | 400 | 400 | 400 | 400 |  |
| `/api/v1/proxy-media` | GET | 401 | 400 | 400 | 400 | 400 |  |
| `/api/v1/search` | GET | 200 | 200 | 200 | 200 | 200 | caller-scoped — searches only the spaces the caller can read; empty without a session |
| `/api/v1/spaces` | GET | 200 | 200 | 200 | 200 | 200 | caller-scoped — lists only spaces the caller belongs to |
| `/api/v1/spaces` | POST | 401 | 400 | 400 | 400 | 400 | caller-scoped — lists only spaces the caller belongs to |
| `/api/v1/spaces/[spaceId]` | DELETE | 401 | 403 | 403 | 403 | 200 |  |
| `/api/v1/spaces/[spaceId]` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]` | PATCH | 401 | 403 | 403 | 403 | 200 |  |
| `/api/v1/spaces/[spaceId]/access-tokens` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/access-tokens` | POST | 401 | 403 | 403 | 403 | 400 |  |
| `/api/v1/spaces/[spaceId]/access-tokens/[tokenId]` | DELETE | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/access-tokens/[tokenId]` | GET | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/access-tokens/[tokenId]` | PATCH | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/ai-chat/sessions` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId]` | DELETE | 401 | 403 | 404 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId]` | GET | 401 | 403 | 404 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/ai-chat/sessions/[sessionId]` | PUT | 401 | 403 | 400 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/audit-logs` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/categories` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/categories` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/categories` | PUT | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/categories/[id]` | DELETE | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/categories/[id]` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/categories/[id]` | PUT | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/comments` | DELETE | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/comments` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/comments` | PATCH | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/comments` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]` | DELETE | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]` | PATCH | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]` | PUT | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/access` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/breadcrumbs` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/children` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/contributors` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/diff` | GET | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/edit` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/revisions` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/revisions` | PATCH | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/[documentId]/revisions` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/documents/archived` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/extensions` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/extensions` | POST | 401 | 403 | 403 | 403 | 400 |  |
| `/api/v1/spaces/[spaceId]/extensions/[extensionId]` | DELETE | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/extensions/[extensionId]` | GET | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/extensions/[extensionId]` | PATCH | 401 | 403 | 403 | 403 | 400 |  |
| `/api/v1/spaces/[spaceId]/extensions/[extensionId]/assets/[...path]` | GET | 401 | 403 | 404 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/extensions/[extensionId]/package` | GET | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/integrations` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/integrations/[provider]` | DELETE | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/integrations/[provider]` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/integrations/[provider]/callback` | GET | 401 | 403 | 302 | 302 | 302 |  |
| `/api/v1/spaces/[spaceId]/integrations/[provider]/connect` | POST | 401 | 403 | 400 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/integrations/[provider]/proxy` | POST | 401 | 403 | 400 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/jobs/run` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/jobs/runs` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/members` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/notification-preference` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/notification-preference` | PATCH | 401 | 403 | 400 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/permissions` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/permissions` | POST | 401 | 403 | 403 | 403 | 200 |  |
| `/api/v1/spaces/[spaceId]/permissions/me` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/properties` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/search` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/search/rebuild` | POST | 401 | 403 | 403 | 403 | 200 |  |
| `/api/v1/spaces/[spaceId]/secrets` | GET | 401 | 403 | 403 | 403 | 200 |  |
| `/api/v1/spaces/[spaceId]/secrets` | POST | 401 | 403 | 403 | 403 | 400 |  |
| `/api/v1/spaces/[spaceId]/secrets/[name]` | DELETE | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/secrets/[name]` | GET | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/secrets/[name]` | HEAD | 401 | 403 | 403 | 403 | 404 |  |
| `/api/v1/spaces/[spaceId]/secrets/[name]` | PUT | 401 | 403 | 403 | 403 | 400 |  |
| `/api/v1/spaces/[spaceId]/settings/ai-provider` | DELETE | 401 | 403 | 403 | 403 | 200 |  |
| `/api/v1/spaces/[spaceId]/settings/ai-provider` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/settings/ai-provider` | PUT | 401 | 403 | 403 | 403 | 400 |  |
| `/api/v1/spaces/[spaceId]/uploads` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/uploads` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/uploads/[...path]` | DELETE | 401 | 403 | 403 | 204 | 204 |  |
| `/api/v1/spaces/[spaceId]/uploads/[...path]` | GET | 401 | 403 | 404 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/workflows/runs` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/workflows/runs` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/workflows/runs/[runId]` | DELETE | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/workflows/runs/[runId]` | GET | 401 | 403 | 404 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/workflows/runs/[runId]` | POST | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/workflows/schedules` | GET | 401 | 403 | 403 | 200 | 200 |  |
| `/api/v1/spaces/[spaceId]/workflows/schedules` | POST | 401 | 403 | 403 | 400 | 400 |  |
| `/api/v1/spaces/[spaceId]/workflows/schedules/[scheduleId]` | DELETE | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/workflows/schedules/[scheduleId]` | GET | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/spaces/[spaceId]/workflows/schedules/[scheduleId]` | PATCH | 401 | 403 | 403 | 404 | 404 |  |
| `/api/v1/url-metadata` | GET | 401 | 400 | 400 | 400 | 400 |  |
| `/api/v1/users` | GET | 401 | 403 | 200 | 200 | 200 |  |
| `/api/v1/users/directory` | GET | 401 | 403 | 403 | 403 | 403 |  |
| `/api/v1/users/me` | GET | 401 | 200 | 200 | 200 | 200 | caller-scoped — the caller's own profile |
| `/api/v1/users/suggestions` | GET | 401 | 200 | 200 | 200 | 200 | caller-scoped — invite suggestions from the caller's own groups |
