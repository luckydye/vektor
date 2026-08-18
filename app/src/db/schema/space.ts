import {
  type AnySQLiteColumn,
  blob,
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

export const document = sqliteTable("document", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  type: text("type"),
  archived: integer("archived", { mode: "boolean" }).default(false).notNull(),
  readonly: integer("readonly", { mode: "boolean" }).default(false).notNull(),
  content: text("content").notNull(),
  searchText: text("search_text"),
  searchEmbedding: text("search_embedding"),
  searchEmbeddingModel: text("search_embedding_model"),
  searchUpdatedAt: integer("search_updated_at", { mode: "timestamp" }),
  currentRev: integer("current_rev").default(0).notNull(),
  publishedRev: integer("published_rev"),
  parentId: text("parent_id").references((): AnySQLiteColumn => document.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
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
    status: text("status"),
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
  (t) => [uniqueIndex("property_document_id_key_unique").on(t.documentId, t.key)],
);

export const category = sqliteTable("category", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  color: text("color"),
  icon: text("icon"),
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
     * The credential this row is opened with, read according to `kind`: an access
     * token's SHA-256, or a share link's Argon2id password verifier. Uniqueness
     * is the `acl_secret_unique` index — SQLite cannot ADD COLUMN with UNIQUE.
     */
    secret: text("secret"),
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

export const oauthIntegration = sqliteTable(
  "oauth_integration",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    userId: text("user_id").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    externalUsername: text("external_username"),
    instanceUrl: text("instance_url"),
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

export const workflowSchedule = sqliteTable("workflow_schedule", {
  id: text("id").primaryKey(),
  /** Workflow document id this schedule runs on each tick */
  documentId: text("document_id")
    .notNull()
    .references(() => document.id, { onDelete: "cascade" }),
  /** Standard 5-field cron expression, e.g. "0 6 * * 1" */
  cronExpression: text("cron_expression").notNull(),
  /** IANA timezone for evaluating the expression (defaults to server time) */
  timezone: text("timezone"),
  /** JSON-encoded runtime inputs passed to the workflow script on each run */
  inputs: text("inputs"),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  /** Next due time, precomputed so the scheduler tick is a cheap range query */
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
});

export type WorkflowSchedule = typeof workflowSchedule.$inferSelect;
export type WorkflowScheduleInsert = typeof workflowSchedule.$inferInsert;

export const jobRun = sqliteTable("job_run", {
  /** Execution id generated by the job runner */
  id: text("id").primaryKey(),
  /** Historical: set for cron-triggered extension job runs before scheduling
   *  moved to workflows exclusively; no longer populated by new runs. */
  scheduleId: text("schedule_id"),
  jobId: text("job_id").notNull(),
  trigger: text("trigger").notNull(), // "cron" | "manual" | "workflow"
  status: text("status").notNull(), // "queued" | "running" | "success" | "failed" | "cancelled" | "timeout"
  error: text("error"),
  queuedAt: integer("queued_at", { mode: "timestamp" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  initiatedBy: text("initiated_by"),
});

export type JobRun = typeof jobRun.$inferSelect;
export type JobRunInsert = typeof jobRun.$inferInsert;

export const aiChatSession = sqliteTable("ai_chat_session", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  messages: text("messages").notNull(),
  conversationHistory: text("conversation_history").notNull(),
  shellSnapshot: text("shell_snapshot"),
  /**
   * Role of the last conversation turn, denormalised out of the history so the
   * session picker can list a space without reading its transcripts.
   */
  lastMessageRole: text("last_message_role"),
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
  /** Relative URL to access the file, e.g. /api/v1/spaces/{spaceId}/uploads/{key} */
  url: text("url"),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
  /** Text extracted from the file for search */
  extractedText: text("extracted_text"),
});
