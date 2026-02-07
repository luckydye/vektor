---
title: API Reference
description: Complete reference for all Wiki API endpoints
---

# API Reference

G'day! This document provides a comprehensive reference for all API endpoints in the Wiki application. All endpoints require authentication unless otherwise noted.

## API Versioning

All API endpoints (except authentication) are versioned under `/api/v1/`. This allows for future breaking changes without affecting existing integrations.

- **Current Version**: v1
- **Base URL**: `/api/v1/`
- **Authentication**: `/api/auth/` (unversioned - stable)

When a new API version is released, the old version will continue to work for a deprecation period.

## Authentication

Authentication is handled via the `/api/auth/*` endpoints using the auth handler. All authenticated requests must include valid session credentials.

**Note**: Authentication endpoints are NOT versioned - they remain at `/api/auth/*` for stability.

### `ALL /api/auth/[...all]`

Handles all authentication-related requests (login, logout, session management).

**Authentication**: Public  
**URL**: `/api/auth/*` (unversioned)

---

## Users

### `GET /api/v1/users`

List all users in the system.

**Authentication**: Required  
**Response**: Array of user objects with `id`, `name`, `email`, `image`

---

## Spaces

### `GET /api/v1/spaces`

List all spaces the authenticated user has access to.

**Authentication**: Required  
**Response**: Array of space objects

### `POST /api/v1/spaces`

Create a new space.

**Authentication**: Required  
**Request Body**:
- `name` (string, required): Space name
- `slug` (string, required): URL-friendly identifier
- `preferences` (object, optional): Space preferences

**Response**: `{ space: Space }` with 201 status

### `GET /api/v1/spaces/{spaceId}`

Get details of a specific space.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: Space object

### `PUT /api/v1/spaces/{spaceId}`

Update a space.

**Authentication**: Required  
**Required Role**: owner  
**Request Body**:
- `name` (string, required): Space name
- `slug` (string, required): URL-friendly identifier
- `preferences` (object, optional): Space preferences

**Response**: Updated space object

### `DELETE /api/v1/spaces/{spaceId}`

Delete a space.

**Authentication**: Required  
**Required Role**: owner  
**Response**: Success status

---

## Space Audit Logs

### `GET /api/v1/spaces/{spaceId}/audit-logs`

Get audit logs for a space.

**Authentication**: Required  
**Required Role**: viewer  
**Query Parameters**:
- `limit` (number, optional, default: 100): Maximum number of logs to return

**Response**: `{ auditLogs: AuditLog[] }`

---

## Space Members

### `GET /api/v1/spaces/{spaceId}/members`

List all members of a space.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: Array of member objects with user data and roles

### `POST /api/v1/spaces/{spaceId}/members`

Add a member to a space.

**Authentication**: Required  
**Required Role**: owner  
**Request Body**:
- `userId` (string, required): User ID to add
- `role` (string, optional, default: "viewer"): Member role (viewer, editor, admin, owner)

**Response**: Member object with 201 status

### `GET /api/v1/spaces/{spaceId}/members/{userId}`

Get a specific space member.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: Member object

### `PUT /api/v1/spaces/{spaceId}/members/{userId}`

Update a space member's role.

**Authentication**: Required  
**Required Role**: owner  
**Request Body**:
- `role` (string, required): New role (viewer, editor, admin, owner)

**Response**: Updated member object

### `DELETE /api/v1/spaces/{spaceId}/members/{userId}`

Remove a member from a space.

**Authentication**: Required  
**Required Role**: owner  
**Response**: Success status

---

## Categories

### `GET /api/v1/spaces/{spaceId}/categories`

List all categories in a space.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ categories: Category[] }`

### `POST /api/v1/spaces/{spaceId}/categories`

Create a new category.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**:
- `name` (string, required): Category name
- `slug` (string, required): URL-friendly identifier
- `description` (string, optional): Category description
- `color` (string, optional): Color code
- `icon` (string, optional): Icon identifier

**Response**: `{ category: Category }` with 201 status

### `GET /api/v1/spaces/{spaceId}/categories/{id}`

Get a specific category.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ category: Category }`

### `PUT /api/v1/spaces/{spaceId}/categories/{id}`

Update a category.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**:
- `name` (string, required): Category name
- `slug` (string, required): URL-friendly identifier
- `description` (string, optional): Category description
- `color` (string, optional): Color code
- `icon` (string, optional): Icon identifier

**Response**: `{ category: Category }`

### `DELETE /api/v1/spaces/{spaceId}/categories/{id}`

Delete a category.

**Authentication**: Required  
**Required Role**: editor  
**Response**: Success status

### `GET /api/v1/spaces/{spaceId}/categories/{slug}/documents`

List all documents in a category.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ documents: Document[], category: Category }`

---

## Documents

### `GET /api/v1/spaces/{spaceId}/documents`

List all documents in a space (without content).

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ documents: Document[] }`

### `POST /api/v1/spaces/{spaceId}/documents`

Create a new document.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**:
- `content` (string, required): Document content (markdown)
- `properties` (object, optional): Document properties (must include `title`)
- `parentId` (string, optional): Parent document ID for hierarchical structure
- `type` (string, optional): Document type

**Response**: `{ document: Document }` with 201 status

### `GET /api/v1/spaces/{spaceId}/documents/archived`

List archived documents.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ documents: Document[] }`

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}`

Get a document with content.

**Authentication**: Required  
**Query Parameters**:
- `rev` (number, optional): Specific revision number to fetch

**Response**: `{ document: Document }` or `{ revision: Revision }` if rev specified

### `PUT /api/v1/spaces/{spaceId}/documents/{documentId}`

Update document content.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**: Raw text content (markdown)  
**Response**: `{ document: Document }`

**Note**: Cannot update readonly documents

### `PATCH /api/v1/spaces/{spaceId}/documents/{documentId}`

Update document metadata (including publishing).

**Authentication**: Required  
**Required Role**: editor (owner for restore)  
**Request Body**:
- `parentId` (string|null, optional): Change parent document
- `publishedRev` (number|null, optional): Set published revision (use this to publish/unpublish)
- `readonly` (boolean, optional): Set readonly status
- `restore` (boolean, optional): Restore archived document (requires owner role)

**Response**: `{ document: Document }`

**Publishing Examples**:
```json
// Publish revision 5
{ "publishedRev": 5 }

// Unpublish document
{ "publishedRev": null }
```

### `DELETE /api/v1/spaces/{spaceId}/documents/{documentId}`

Archive or permanently delete a document.

**Authentication**: Required  
**Required Role**: owner  
**Query Parameters**:
- `permanent` (boolean, optional, default: false): Permanently delete instead of archiving

**Response**: Success status

### `POST /api/v1/spaces/{spaceId}/documents/{documentId}`

Create a new revision from HTML content.

**Authentication**: Required  
**Request Body**:
- `html` (string, required): HTML content to save
- `message` (string, optional): Revision message

**Response**: `{ revision: Revision }`

**Note**: Cannot save readonly documents

---

## Document Audit Logs

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}/audit-logs`

Get audit logs for a document.

**Authentication**: Required  
**Query Parameters**:
- `limit` (number, optional, default: 100): Maximum number of logs

**Response**: `{ auditLogs: AuditLog[] }`

---

## Document Children

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}/children`

Get child documents of a document.

**Authentication**: Required  
**Response**: `{ children: Document[] }`

---

## Document Contributors

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}/contributors`

Get all users who have contributed to a document.

**Authentication**: Required  
**Response**: `{ contributors: User[] }`

---

## Document History

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}/revisions`

Get revision history for a document.

**Authentication**: Required  
**Response**: `{ revisions: Revision[] }`

---

## Document Properties

### `PUT /api/v1/spaces/{spaceId}/documents/{documentId}/property`

Update or create a document property.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**:
- `key` (string, required): Property key
- `value` (string, required): Property value
- `type` (string, optional): Property type

**Response**: Changed properties object

### `DELETE /api/v1/spaces/{spaceId}/documents/{documentId}/property`

Delete a document property.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**:
- `key` (string, required): Property key to delete

**Response**: Success status

---

---

## Document Restore

### `POST /api/v1/spaces/{spaceId}/documents/{documentId}/publish?rev={rev}`

Restore a document to a previous revision (creates new revision).

**Authentication**: Required  
**Required Role**: editor  
**Request Body**:
- `message` (string, optional): Restore message

**Response**: `{ revision: Revision }`

---

## Document Members

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}/members`

List members with specific permissions on a document.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: Array of document member objects

### `POST /api/v1/spaces/{spaceId}/documents/{documentId}/members`

Grant document-specific permissions to a user.

**Authentication**: Required  
**Required Role**: owner  
**Request Body**:
- `userId` (string, required): User ID
- `role` (string, optional, default: "editor"): Role (viewer, editor, owner)

**Response**: Member object with 201 status

### `GET /api/v1/spaces/{spaceId}/documents/{documentId}/members/{userId}`

Get a specific document member.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: Member object

### `PUT /api/v1/spaces/{spaceId}/documents/{documentId}/members/{userId}`

Update document member role.

**Authentication**: Required  
**Required Role**: owner  
**Request Body**:
- `role` (string, required): New role

**Response**: Updated member object

### `DELETE /api/v1/spaces/{spaceId}/documents/{documentId}/members/{userId}`

Remove document-specific permissions from a user.

**Authentication**: Required  
**Required Role**: owner  
**Response**: Success status

---

## Search

### `GET /api/v1/spaces/{spaceId}/search`

Search documents in a space.

**Authentication**: Required  
**Query Parameters**:
- `q` (string, required): Search query
- `limit` (number, optional, default: 20, max: 100): Results per page
- `offset` (number, optional, default: 0): Pagination offset

**Response**: `{ results: Document[], total: number, query: string, limit: number, offset: number }`

### `POST /api/v1/spaces/{spaceId}/search/rebuild`

Rebuild the search index for a space.

**Authentication**: Required  
**Required Role**: owner  
**Response**: Success message

---

## Properties

### `GET /api/v1/spaces/{spaceId}/properties`

Get all properties and their possible values across documents in a space.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ properties: PropertyInfo[] }`

---

## Uploads

### `POST /api/v1/spaces/{spaceId}/uploads`

Upload an image file.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**: FormData with `file` field  
**Allowed Types**: JPEG, PNG, GIF, WebP, SVG  
**Max Size**: 10MB

**Response**: `{ url: string }` - URL to access the uploaded image

### `GET /api/v1/spaces/{spaceId}/uploads/{filename}`

Retrieve an uploaded image.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: Image file with appropriate Content-Type header

---

## Webhooks

### `GET /api/v1/spaces/{spaceId}/webhooks`

List all webhooks in a space.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ webhooks: Webhook[] }`

### `POST /api/v1/spaces/{spaceId}/webhooks`

Create a new webhook.

**Authentication**: Required  
**Required Role**: admin  
**Request Body**:
- `url` (string, required): Webhook URL
- `events` (string[], required): Array of event types to trigger on
  - Valid events: `document.published`, `document.unpublished`, `document.deleted`, `mention`
- `documentId` (string, optional): Limit webhook to specific document
- `secret` (string, optional): Secret for webhook signature verification

**Response**: `{ webhook: Webhook }`

### `GET /api/v1/spaces/{spaceId}/webhooks/{webhookId}`

Get a specific webhook.

**Authentication**: Required  
**Required Role**: viewer  
**Response**: `{ webhook: Webhook }`

### `PATCH /api/v1/spaces/{spaceId}/webhooks/{webhookId}`

Update a webhook.

**Authentication**: Required  
**Required Role**: admin  
**Request Body**:
- `url` (string, optional): Webhook URL
- `events` (string[], optional): Event types
- `documentId` (string|null, optional): Document filter
- `secret` (string|null, optional): Signature secret
- `enabled` (boolean, optional): Enable/disable webhook

**Response**: `{ webhook: Webhook }`

### `DELETE /api/v1/spaces/{spaceId}/webhooks/{webhookId}`

Delete a webhook.

**Authentication**: Required  
**Required Role**: admin  
**Response**: `{ success: true }`

---

## Import

### `POST /api/v1/spaces/{spaceId}/import`

Import documents from WIF (Wiki Interchange Format) files.

**Authentication**: Required  
**Required Role**: editor  
**Request Body**: FormData with `file` field  
**Supported Format**: WIF ZIP archives only (.wif.zip or .zip)

**Max Size**: 100MB

**Response**: `{ totalFiles: number, imported: number, skipped: number, failed: number, documents: Document[], errors: string[] }`

**WIF Format Structure**:
```
export-name.wif.zip
├── wif.json              # Manifest file
├── documents/            # Markdown documents with YAML frontmatter
│   ├── index.md
│   └── path/
│       └── to/
│           └── document.md
└── media/                # Attachments and images
    └── path/
        └── to/
            └── image.png
```

**Document Frontmatter**:
```yaml
---
wif_version: "1.0"
slug: "my-document"
title: "My Document"
created_at: "2024-01-15T10:30:00Z"
modified_at: "2024-01-20T14:22:00Z"
author: "user@example.com"
parent: "parent-document-slug"
order: 1
category: "documentation"
properties:
  key: "value"
---
```

**Notes**:
- Documents must have YAML frontmatter with at least `wif_version`, `slug`, and `title`
- Document hierarchy is determined by `parent` field in frontmatter
- Media files are automatically uploaded and image references are updated
- Existing slugs are automatically handled with unique suffixes
- Use `bun scripts/convert-xwiki-to-wif.ts` to convert XWiki exports to WIF format

---

## Response Formats

### Success Response
```json
{
  "status": "success",
  "message": "Optional message"
}
```

### Error Response
```json
{
  "error": "Error message",
  "status": 400
}
```

---

## Role Hierarchy

Roles in descending order of permissions:
1. **owner** - Full control including deletion
2. **admin** - Administrative access (webhooks, settings)
3. **editor** - Can create and edit content
4. **viewer** - Read-only access

Higher roles inherit permissions of lower roles.

---

## Common HTTP Status Codes

- **200 OK** - Successful GET/PUT/PATCH request
- **201 Created** - Successful POST request creating a resource
- **400 Bad Request** - Invalid request parameters or body
- **401 Unauthorized** - Authentication required
- **403 Forbidden** - Insufficient permissions
- **404 Not Found** - Resource not found
- **500 Internal Server Error** - Server error

---

## Rate Limiting

Rate limiting can be configured via the `x-forwarded-for` header in the auth handler. Check your deployment configuration for specific limits.

---

## Webhooks

When webhooks are triggered, they receive POST requests with the following structure:

```json
{
  "event": "document.published",
  "spaceId": "space-id",
  "documentId": "document-id",
  "revisionId": 5,
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {}
}
```

For `mention` events, the data object includes:
```json
{
  "data": {
    "mentionedUser": "user@example.com",
    "mentionedBy": "user-id"
  }
}
```

If a secret is configured, requests include an `X-Webhook-Signature` header for verification.
