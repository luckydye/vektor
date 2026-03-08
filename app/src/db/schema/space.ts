import {
  blob,
  integer,
  sqliteTable,
  text,
  primaryKey,
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
  parentId: text("parent_id").references((): any => document.id, {
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
  message: text("message"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
});

export const property = sqliteTable("property", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => document.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  type: text("type"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

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

export const connection = sqliteTable("connection", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  url: text("url"),
  icon: text("icon"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

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

export const webhook = sqliteTable("webhook", {
  id: text("id").primaryKey(),
  url: text("url").notNull(),
  events: text("events").notNull(),
  documentId: text("document_id").references(() => document.id, { onDelete: "cascade" }),
  secret: text("secret"),
  enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  createdBy: text("created_by").notNull(),
});

export type Webhook = typeof webhook.$inferSelect;
export type WebhookInsert = typeof webhook.$inferInsert;

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
