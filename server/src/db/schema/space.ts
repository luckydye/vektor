import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const spaceMetadata = sqliteTable("space_metadata", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  /** The source of every `document.change_seq`. One row per space database. */
  changeSeq: integer("change_seq").notNull().default(0),
});

export const preference = sqliteTable("preference", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  userId: text("user_id"),
});

export const comment = sqliteTable("comment", {
  id: text("id").primaryKey(),
  /** Id of parent comment/thread */
  parentId: text("parent_id"),
  /** Comment type like text/reaction */
  type: text("type").notNull(),
  archived: integer("archived", { mode: "boolean" }).default(false).notNull(),
  content: text("content"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  /** A reference to some content like a line-number or block id */
  reference: text("reference"),
});

export const extension = sqliteTable("extension", {
  id: text("id").primaryKey(),
  package: blob("snapshot", { mode: "buffer" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  source: text("source").notNull().default("upload"),
  sourceRef: text("source_ref"),
  sourcePublisher: text("source_publisher"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
});

/**
 * Column order is the physical row layout, and it matters: SQLite reads a row's
 * columns front to back, so anything after the large text columns is reached
 * only by walking their overflow pages. The small columns that listings and
 * the tree walk read come first; `content`, `search_text` and `search_embedding`
 * (~8KB each) stay last.
 */
export const document = sqliteTable("document", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  type: text("type"),
  archived: integer("archived", { mode: "boolean" }).default(false).notNull(),
  readonly: integer("readonly", { mode: "boolean" }).default(false).notNull(),
  parentId: text("parent_id").references((): AnySQLiteColumn => document.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
  currentRev: integer("current_rev").default(0).notNull(),
  publishedRev: integer("published_rev"),
  /**
   * The document's entity tag; see `#db/space/changeSeq.ts`. Not `currentRev`,
   * which a property patch, a publish or a move all leave alone.
   */
  changeSeq: integer("change_seq").notNull().default(0),
  /** Blob store key of content too large to inline, which leaves `content` empty; see `#db/space/documentContent.ts`. */
  contentKey: text("content_key"),
  searchEmbeddingModel: text("search_embedding_model"),
  searchUpdatedAt: integer("search_updated_at", { mode: "timestamp" }),
  content: text("content").notNull(),
  searchText: text("search_text"),
  searchEmbedding: text("search_embedding"),
});

export const revision = sqliteTable(
  "revision",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    rev: integer("rev").notNull(),
    slug: text("slug").notNull(),
    snapshot: blob("snapshot", { mode: "buffer" }).notNull(),
    checksum: text("checksum").notNull(),
    parentRev: integer("parent_rev"),
    message: text("message"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  // `currentRev` and `publishedRev` are (documentId, rev) pointers, so a second
  // row at one number makes them ambiguous rather than merely untidy.
  (t) => [uniqueIndex("revision_document_id_rev_unique").on(t.documentId, t.rev)],
);

export const property = sqliteTable(
  "property",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: text("value").notNull(),
    type: text("type"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    uniqueIndex("property_document_id_key_unique").on(t.documentId, t.key),
    // Reverse lookup: which document claims this key and value.
    index("property_key_value_idx").on(t.key, t.value),
    index("property_key_type_idx").on(t.key, t.type),
  ],
);

export const category = sqliteTable("category", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  color: text("color"),
  icon: text("icon"),
  /** A `CategoryDocumentSort`; null is the default, alphanumeric. */
  documentSort: text("document_sort"),
  /** How many root documents the sidebar shows before "Show more"; null shows all. */
  documentLimit: integer("document_limit"),
  order: integer("order").default(0).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * Every permission grant in the space — and every credential, because an access
 * token and a share link *are* grants that carry one. Folding them together
 * means a credential cannot outlive its grant or leave one behind: the row is
 * both, scoped to exactly one resource.
 *
 * The trailing columns are null on an ordinary grant.
 */
export const acl = sqliteTable(
  "acl",
  {
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    userId: text("user_id"),
    groupId: text("group_id"),
    permission: text("permission").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),

    /** Human label for a credential, shown in space settings. */
    name: text("name"),
    /**
     * The credential this row is opened with, read according to `kind`: an
     * access token's SHA-256, or a share link's Argon2id password verifier; null
     * on the ordinary grants that carry none.
     */
    secret: text("secret").unique(),
    /**
     * `token`, `link`, or null on a grant carrying no credential. It says how
     * `secret` reads, and keeps the editor-facing share endpoints away from
     * owner-minted access tokens.
     */
    kind: text("kind"),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    /** The user an access token delegates; it never outranks what they hold. */
    createdBy: text("created_by"),
    /** Soft revoke: the row keeps its grant but stops authenticating. */
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.resourceType, table.resourceId, table.userId, table.groupId],
    }),
  }),
);

export type AclEntry = typeof acl.$inferSelect;
export type AclInsert = typeof acl.$inferInsert;

/** An `acl` row that carries a credential. */
export type AccessToken = AclEntry & { secret: string; createdBy: string };

export const spaceSecret = sqliteTable(
  "space_secret",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (table) => ({
    secretNameUnique: uniqueIndex("space_secret_name_unique").on(table.name),
  }),
);

/**
 * A runner a space owner registered: an HTTP endpoint that runs jobs, and
 * agents when it offers them (docs/runners.md). The server authenticates
 * to it with the encrypted secret.
 */
export const spaceRunner = sqliteTable(
  "runner",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    /** JSON: what it answered `describe` with, a `RunnerDescription`. */
    description: text("description").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    authTag: text("auth_tag").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("runner_name_unique").on(table.name)],
);

export const oauthIntegration = sqliteTable(
  "oauth_integration",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    externalUsername: text("external_username"),
    instanceUrl: text("instance_url"),
    /** The client the provider registered for this user, when it registers one per user. */
    clientId: text("client_id"),
    /** The model the user's agent chats run on, for integrations that provide one. */
    aiModel: text("ai_model"),
    scope: text("scope"),
    accessTokenCiphertext: text("access_token_ciphertext").notNull(),
    accessTokenIv: text("access_token_iv").notNull(),
    accessTokenAuthTag: text("access_token_auth_tag").notNull(),
    refreshTokenCiphertext: text("refresh_token_ciphertext"),
    refreshTokenIv: text("refresh_token_iv"),
    refreshTokenAuthTag: text("refresh_token_auth_tag"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  },
  (table) => ({
    providerUserUnique: uniqueIndex("oauth_integration_provider_user_unique").on(
      table.provider,
      table.userId,
    ),
  }),
);

export const oauthIntegrationState = sqliteTable(
  "oauth_integration_state",
  {
    id: text("id").primaryKey(),
    state: text("state").notNull(),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    redirectTo: text("redirect_to"),
    instanceUrl: text("instance_url"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    stateUnique: uniqueIndex("oauth_integration_state_unique").on(table.state),
  }),
);

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  docId: text("doc_id").notNull(),
  revisionId: integer("revision_id"),
  userId: text("user_id"),
  event: text("event").notNull(),
  details: text("details"),
  /** JSON `Attribution`: the app that acted, and for whom. Null for a person acting directly. */
  attribution: text("attribution"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;

export const emailNotificationOutbox = sqliteTable(
  "email_notification_outbox",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    sourceId: text("source_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    /** Revision published by this event, retained for an accurate email preview. */
    publishedRevision: integer("published_revision"),
    /** The version that was published immediately before this event. */
    previousPublishedRevision: integer("previous_published_revision"),
    actorId: text("actor_id").notNull(),
    recipientUserId: text("recipient_user_id").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: integer("available_at", { mode: "timestamp" }).notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp" }),
  },
  (table) => [
    uniqueIndex("email_notification_outbox_event_recipient_unique").on(
      table.kind,
      table.sourceId,
      table.recipientUserId,
    ),
  ],
);

export type EmailNotificationOutbox = typeof emailNotificationOutbox.$inferSelect;

export const workflowSchedule = sqliteTable(
  "workflow_schedule",
  {
    id: text("id").primaryKey(),
    /** Workflow document id this schedule runs; null for an agent schedule. */
    documentId: text("document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    /**
     * What the agent is told when the schedule fires, as a new chat session of
     * `createdBy`. Set instead of `documentId` for an agent schedule.
     */
    prompt: text("prompt"),
    /** The chat session an agent schedule posts into; null opens a new one each time. */
    sessionId: text("session_id"),
    /** Null for a one-shot schedule; otherwise a standard 5-field cron expression. */
    cronExpression: text("cron_expression"),
    /** Document property that owns a one-shot schedule. */
    sourceDocumentId: text("source_document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    propertyKey: text("property_key"),
    /** IANA timezone for evaluating the expression (defaults to server time) */
    timezone: text("timezone"),
    /** JSON-encoded runtime inputs passed to the workflow script on each run */
    inputs: text("inputs"),
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    /** Due time; retained after a one-shot is consumed to detect unchanged writes. */
    nextRunAt: integer("next_run_at", { mode: "timestamp" }),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("workflow_schedule_source_property_unique").on(
      t.sourceDocumentId,
      t.propertyKey,
    ),
    index("workflow_schedule_next_run_at_idx").on(t.enabled, t.nextRunAt),
  ],
);

export type WorkflowSchedule = typeof workflowSchedule.$inferSelect;
export type WorkflowScheduleInsert = typeof workflowSchedule.$inferInsert;

/**
 * An agent conversation. A `space` session without a parent is a bot's channel
 * (`title` is the bot's name); one with a parent is a thread in that channel. A
 * `private` session belongs to its creator alone: jobs, schedules, the CLI.
 */
export const chatSession = sqliteTable("chat_session", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** The creator; a channel's owner, whose provider and nodes its bot uses. */
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  shellSnapshot: text("shell_snapshot"),
  /** Who opened the session: the chat UI ("chat") or a job such as a workflow run ("job"). */
  source: text("source", { enum: ["chat", "job"] })
    .notNull()
    .default("chat"),
  /** The node the agent runs on, by name; null runs it on the server. */
  node: text("node"),
  visibility: text("visibility", { enum: ["space", "private"] })
    .notNull()
    .default("private"),
  /** The minimum space role to post; always `editor` on a node. */
  access: text("access", { enum: ["viewer", "editor"] })
    .notNull()
    .default("editor"),
  /** The bot's role; null is a general assistant. */
  rolePrompt: text("role_prompt"),
  avatar: text("avatar"),
  /** What the bot remembers of the rows up to `memoryThroughSeq`. */
  memory: text("memory").notNull().default(""),
  memoryThroughSeq: integer("memory_through_seq").notNull().default(0),
  /** The last user row a round answered. */
  repliedThroughSeq: integer("replied_through_seq").notNull().default(0),
  /** The channel a thread belongs to. */
  parentSessionId: text("parent_session_id"),
  /** The channel row a thread replies to. */
  threadRootSeq: integer("thread_root_seq"),
  /** The agent the session runs on `node`. */
  nodeAgent: text("node_agent"),
  /** The bot channel that spawned and manages this one; null for a person's bot. */
  managedBy: text("managed_by"),
});

export type ChatSessionRow = typeof chatSession.$inferSelect;

/**
 * Every session's log in one append-only table, in the model's message shape;
 * the UI renders the same rows. `seq` is global, so a thread's root is one number.
 */
export const chatMessage = sqliteTable(
  "chat_message",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    /** Who posted it; null for the bot and for model-only rows. */
    authorId: text("author_id"),
    content: text("content").notNull(),
    /** False for rows only the model reads, e.g. additional context. */
    visible: integer("visible", { mode: "boolean" }).notNull().default(true),
    /** JSON `ChatMessageMetadata`. */
    metadata: text("metadata").notNull().default("{}"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("chat_message_session_seq_idx").on(t.sessionId, t.seq)],
);

export type ChatMessageRow = typeof chatMessage.$inferSelect;

/** Estimated AI tokens charged to a space for a UTC week (Monday to Monday). */
export const aiWeeklyUsage = sqliteTable("ai_weekly_usage", {
  weekStart: text("week_start").primaryKey(),
  tokens: integer("tokens").notNull().default(0),
});

/** Ephemeral full-text index of uploaded files. Fully rebuildable by scanning the uploads directory. */
export const file = sqliteTable("file", {
  /** Content-addressable storage key under uploads/{spaceId}/, e.g. "{hash[0:2]}/{hash}.{ext}" */
  path: text("path").primaryKey(),
  /** Document this file belongs to, if scoped to one. Null = standalone upload. */
  documentId: text("document_id").references((): AnySQLiteColumn => document.id, {
    onDelete: "cascade",
  }),
  /** Original filename as uploaded (not the randomised on-disk name) */
  originalName: text("original_name"),
  mimeType: text("mime_type"),
  /** Size of the stored bytes, for listings that label a file without reading it */
  size: integer("size"),
  /**
   * Pixel dimensions, read from the image's header once at upload. Null on a
   * non-image, and on a row indexed before these columns existed.
   *
   * Stored for the same reason as `size` and `extractedText`: so a page that
   * needs a fact about a file does not have to fetch the file to learn it. The
   * header image's aspect ratio is wanted during SSR, where reaching storage
   * costs a read per render of a value that never changes — the keys are
   * content hashes, so these are immutable for the life of the row.
   */
  width: integer("width"),
  height: integer("height"),
  /** Relative URL to access the file, e.g. /api/v1/spaces/{spaceId}/uploads/{key} */
  url: text("url"),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
  /** Text extracted from the file for search */
  extractedText: text("extracted_text"),
});

/**
 * What a time series is, never what it contains: points live only as objects
 * under `series/{id}/` in file storage (see `#series/store.ts`).
 */
export const series = sqliteTable(
  "series",
  {
    /** UUID, never reused; it names the storage prefix. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    documentId: text("document_id").references(() => document.id, {
      onDelete: "cascade",
    }),
    /** Immutable: every stored key is laid out in windows of this length. */
    windowSeconds: integer("window_seconds").notNull(),
    /** Null keeps points forever. */
    retentionDays: integer("retention_days"),
    compactAfterSegments: integer("compact_after_segments").notNull(),
    /** The compaction claim, in ms; expires after `SERIES_CLAIM_TTL_MS`. */
    compactingAt: integer("compacting_at"),
    /** The earliest window that may still hold objects, where pruning starts. */
    oldestWindow: integer("oldest_window"),
    /** Cosmetic totals of what was appended, not of what is stored. */
    pointCount: integer("point_count").notNull().default(0),
    byteCount: integer("byte_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [uniqueIndex("series_name_unique").on(t.name)],
);

export type SeriesRow = typeof series.$inferSelect;

/**
 * Windows waiting for compaction or for their superseded objects to be
 * collected. `segments` counts appends not yet absorbed by a chunk.
 */
export const seriesDirtyWindow = sqliteTable(
  "series_dirty_window",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => series.id, { onDelete: "cascade" }),
    window: integer("window").notNull(),
    segments: integer("segments").notNull().default(0),
    /** When the objects the newest chunk superseded may be deleted, in ms. */
    collectAt: integer("collect_at"),
  },
  (t) => [primaryKey({ columns: [t.seriesId, t.window] })],
);
