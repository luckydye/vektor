# Vektor — Feature List

## Spaces & Organization
- Create multiple isolated spaces with custom names, slugs, and descriptions
- Per-space branding: custom color, logo (SVG/PNG/JPEG)
- Space home with pinned and recently edited documents
- Space activity feed — timeline of recent changes and contributions
- Archive documents within a space; view/restore archived items
- Role-based space membership (owner, editor, viewer)

## Documents
- Rich text documents (Tiptap editor)
- Canvas documents (infinite whiteboard)
- Databases (structured tables)
- Workflows (sandboxed workflow js scripts)
- Apps (embeddable HTML/JS documents)
- Hierarchical document tree with parent-child nesting

## Document Editing
- Real-time multiplayer editing via Yjs
- Full rich text: bold, italic, underline, strikethrough, blockquotes, ordered/unordered lists
- Tables
- Code blocks with syntax highlighting (CodeMirror)
- Inline mentions for users and documents with autocomplete
- Document properties — custom key-value metadata
- Document categories — color-coded tags
- Cover/header images
- File attachments, image, audio, and video embedding

**Canvas**
- Freehand drawing with pen, marker, and highlight stroke styles
- Shapes: text boxes, sticky notes (with color options), sections, links
- Embedded document links with content previews
- Inline editing of embedded documents (double-click a card to edit it collaboratively in place)
- Select, move, resize, and rotate shapes
- Alignment snapping guides
- Copy, paste, and duplicate shapes
- Viewport pan and zoom with keyboard shortcuts
- Grid and clean backdrop options
- Paste directly from Figma (Figma clipboard)

## Document Publishing & History
- Published revisions — publish a specific version for external sharing
- Revision history sidebar with full list of saved revisions
- Diff view — visual comparison between any two revisions
- Markdown export
- Print support
- Readonly mode — lock a document against further edits
- Link preview expansion for embedded URLs

## Collaboration & Comments
- Inline comment threads anchored to document content
- Threaded replies on comments
- Mention users inside comment threads
- Visual comment bubble indicators on commented sections
- Contributors list per document

## Databases
- Create and modify table schema (columns and data types)
- Add, edit, and delete rows
- Filter and sort
- Pagination for large datasets
- Inline cell editing

## Search & Discovery
- Full-text search across all documents
- Semantic / vector similarity search
- Filter by properties, categories, and document type

## AI & Chat
- Docked AI chat panel inside documents
- Persistent chat sessions — save and revisit multiple conversations
- OpenAI-compatible `/v1/chat/completions` endpoint
- Configurable AI provider per space (model, credentials)
- MCP (Model Context Protocol) server for Claude, Cursor, and similar tools
  - `list_documents`, `search_documents`, `get_document`, `upload_artifact`, `install_extension`

## Workflows & Job Execution
- Sandboxed JavaScript workflow scripts
- Execute workflows and track run status and logs

## Extensions
- Install and update extensions from the settings panel
- Extensions can
  - define custom routes/pages
  - contribute workflow job types
  - add navigation menu items
  - render content on the space home page or be placed in documents
  - serve static assets

## File Uploads & Media
- File upload with drag-and-drop support anywhere in the editor
- Persistent file storage with URL-based access
- Image transformation (resize via URL parameters)
- Text extraction from uploaded files for full-text search (limited)

## Permissions & Access Control
- Role-based ACL: owner, editor, viewer at space and document level
- User groups for bulk permission management
- Feature flags per user or group
- API access tokens with 30-day expiry
- Token scoping to specific spaces, documents, or extensions

## Authentication
- SSO Multi-provider OAuth2 login (powered by better-auth)
- Separate CLI authentication flow

## API & Developer Tools
- Full REST API for all resources
- OpenTelemetry tracing support
- OAuth2 apps integrations (currently Gitlab and YouTrack)
- Encrypted secret/credential storage per space
- CalDAV calendar sync protocol

## Audit & Compliance
- Space-level audit log (user, timestamp, event)
- Document-level change history with parent-child revision tracking
- Contributor tracking (who edited and when)
