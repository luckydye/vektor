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

export const revision = sqliteTable("revision", {
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
});

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
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.resourceType, table.resourceId, table.userId, table.groupId],
    }),
  }),
);

export type AclEntry = typeof acl.$inferSelect;
export type AclInsert = typeof acl.$inferInsert;

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

export const accessToken = sqliteTable("access_token", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
});

export type AccessToken = typeof accessToken.$inferSelect;
export type AccessTokenInsert = typeof accessToken.$inferInsert;

export const jobSchedule = sqliteTable("job_schedule", {
  id: text("id").primaryKey(),
  /** Job id from an extension manifest's jobs array (unique within a space) */
  jobId: text("job_id").notNull(),
  /** Standard 5-field cron expression, e.g. "0 6 * * 1" */
  cronExpression: text("cron_expression").notNull(),
  /** IANA timezone for evaluating the expression (defaults to server time) */
  timezone: text("timezone"),
  /** JSON-encoded inputs passed to the job on each run */
  inputs: text("inputs"),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  /** Next due time, precomputed so the scheduler tick is a cheap range query */
  nextRunAt: integer("next_run_at", { mode: "timestamp" }),
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
});

export type JobSchedule = typeof jobSchedule.$inferSelect;
export type JobScheduleInsert = typeof jobSchedule.$inferInsert;

export const jobRun = sqliteTable("job_run", {
  /** Execution id generated by the job runner */
  id: text("id").primaryKey(),
  /** Set for cron-triggered runs; history is kept when the schedule is deleted */
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

export const workflowRun = sqliteTable("workflow_run", {
  /** Run id from createId("run") */
  id: text("id").primaryKey(),
  /** Workflow document this run belongs to */
  documentId: text("document_id").notNull(),
  /** NodeStatus: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" */
  status: text("status").notNull(),
  initiatedByUserId: text("initiated_by_user_id"),
  sourceExtensionId: text("source_extension_id"),
  /** JSON: sanitized Record<string, unknown> of runtime inputs */
  runtimeInputs: text("runtime_inputs").notNull(),
  /** JSON: sanitized Record<nodeId, PersistedNodeState> */
  nodes: text("nodes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type WorkflowRunRow = typeof workflowRun.$inferSelect;
export type WorkflowRunInsert = typeof workflowRun.$inferInsert;

export const aiChatSession = sqliteTable("ai_chat_session", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  messages: text("messages").notNull(),
  conversationHistory: text("conversation_history").notNull(),
  shellSnapshot: text("shell_snapshot"),
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
  /** Relative URL to access the file, e.g. /api/v1/spaces/{spaceId}/uploads/{key} */
  url: text("url"),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
  /** Text extracted from the file for search */
  extractedText: text("extracted_text"),
});
