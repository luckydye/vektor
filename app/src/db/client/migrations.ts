/**
 * The ordered schema migrations of a space database. A change to
 * `#db/schema/space.ts` reaches an existing database only through an entry
 * appended here; never edit one that has shipped.
 */

import { eq, isNull, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as spaceSchema from "#db/schema/space.ts";
import { lastMessageRoleOf } from "#db/space/aiChatSessions.ts";
import type { Migration } from "./migrator.ts";
import { exec } from "./query.ts";
import {
  addColumnIfMissing,
  generateCreateTableSQL,
  renameColumnIfNeeded,
} from "./schemaUtils.ts";
import type { SpaceDb } from "./store.ts";

export async function createTables(db: SpaceDb, tables: SQLiteTable[]): Promise<void> {
  for (const table of tables) {
    await exec(db, sql.raw(generateCreateTableSQL(table)));
  }
}

async function run(db: SpaceDb, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await exec(db, sql.raw(statement));
  }
}

/**
 * Derive `last_message_role` for sessions stored before the column existed. A
 * row with an empty or unreadable history keeps its null, which reads as no role.
 */
async function backfillAIChatSessionRoles(db: SpaceDb): Promise<void> {
  const rows = await db
    .select({
      id: spaceSchema.aiChatSession.id,
      conversationHistory: spaceSchema.aiChatSession.conversationHistory,
    })
    .from(spaceSchema.aiChatSession)
    .where(isNull(spaceSchema.aiChatSession.lastMessageRole));

  for (const row of rows) {
    let role: string | null = null;
    try {
      const parsed = JSON.parse(row.conversationHistory) as unknown;
      if (Array.isArray(parsed)) role = lastMessageRoleOf(parsed);
    } catch {
      // An unreadable transcript is not worth failing the migration over.
    }
    if (!role) continue;

    await db
      .update(spaceSchema.aiChatSession)
      .set({ lastMessageRole: role })
      .where(eq(spaceSchema.aiChatSession.id, row.id));
  }
}

/**
 * Every schema change made before databases were versioned. Idempotent, unlike
 * the migrations after it: a database predating the stamp replays it once.
 */
async function baseline(db: SpaceDb): Promise<void> {
  await createTables(db, [
    spaceSchema.spaceMetadata,
    spaceSchema.document,
    spaceSchema.revision,
    spaceSchema.property,
    spaceSchema.category,
    spaceSchema.preference,
    spaceSchema.extension,
    spaceSchema.comment,
    spaceSchema.acl,
    spaceSchema.auditLog,
    spaceSchema.emailNotificationOutbox,
    spaceSchema.aiChatSession,
    spaceSchema.workflowSchedule,
    spaceSchema.jobRun,
    spaceSchema.spaceSecret,
    spaceSchema.oauthIntegration,
    spaceSchema.oauthIntegrationState,
    spaceSchema.file,
  ]);

  await run(db, [
    "CREATE INDEX IF NOT EXISTS document_updated_at_idx ON document (updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS document_parent_id_idx ON document (parent_id)",
    "CREATE INDEX IF NOT EXISTS document_workflow_run_parent_created_idx ON document (parent_id, created_at DESC) WHERE type = 'workflow-run'",
    "CREATE UNIQUE INDEX IF NOT EXISTS property_document_id_key_unique ON property (document_id, key)",
    "CREATE UNIQUE INDEX IF NOT EXISTS revision_document_id_rev_unique ON revision (document_id, rev)",
    "CREATE INDEX IF NOT EXISTS audit_log_doc_id_created_at_idx ON audit_log (doc_id, created_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC, id DESC)",
    "CREATE UNIQUE INDEX IF NOT EXISTS email_notification_outbox_event_recipient_unique ON email_notification_outbox (kind, source_id, recipient_user_id)",
    "CREATE INDEX IF NOT EXISTS email_notification_outbox_due_idx ON email_notification_outbox (status, available_at)",
    "CREATE INDEX IF NOT EXISTS workflow_schedule_next_run_at_idx ON workflow_schedule (enabled, next_run_at)",
    "CREATE INDEX IF NOT EXISTS job_run_queued_at_idx ON job_run (queued_at)",
  ]);

  await renameColumnIfNeeded(db, spaceSchema.acl.secret, "token");
  for (const column of [
    spaceSchema.acl.name,
    spaceSchema.acl.secret,
    spaceSchema.acl.kind,
    spaceSchema.acl.expiresAt,
    spaceSchema.acl.lastUsedAt,
    spaceSchema.acl.createdBy,
    spaceSchema.acl.revokedAt,
  ]) {
    await addColumnIfMissing(db, column);
  }
  // Every credential row predating `kind` is an access token, and the principal
  // is now the credential's own id rather than a `token:`-prefixed one.
  await run(db, [
    "UPDATE acl SET kind = 'token' WHERE kind IS NULL AND secret IS NOT NULL",
    "UPDATE acl SET user_id = substr(user_id, 7) WHERE user_id LIKE 'token:%'",
    // SQLite carries an index across a rename, so the old one still guards it.
    "DROP INDEX IF EXISTS acl_token_unique",
    "CREATE UNIQUE INDEX IF NOT EXISTS acl_secret_unique ON acl (secret)",
    "DROP TABLE IF EXISTS access_token",
  ]);

  await addColumnIfMissing(db, spaceSchema.aiChatSession.lastMessageRole);
  await backfillAIChatSessionRoles(db);

  await addColumnIfMissing(db, spaceSchema.file.size);
  await addColumnIfMissing(db, spaceSchema.file.width);
  await addColumnIfMissing(db, spaceSchema.file.height);
}

/**
 * The space write counter behind `document.change_seq`, the entity tag every
 * conditional document request compares against.
 *
 * Documents that predate it are numbered least recently edited first, so the
 * counter ends at the document count and the next allocation is unused. The
 * backfill is skipped once the counter has moved, in case the step is ever
 * replayed against a database whose rows are already live.
 */
async function documentChangeSeq(db: SpaceDb): Promise<void> {
  await addColumnIfMissing(db, spaceSchema.spaceMetadata.changeSeq);
  await addColumnIfMissing(db, spaceSchema.document.changeSeq);
  await exec(
    db,
    sql.raw("CREATE INDEX IF NOT EXISTS property_key_value_idx ON property (key, value)"),
  );

  const [counter] = await db
    .select({ changeSeq: spaceSchema.spaceMetadata.changeSeq })
    .from(spaceSchema.spaceMetadata);
  if (counter && counter.changeSeq > 0) return;

  await run(db, [
    `UPDATE document SET change_seq = (
       SELECT seq FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY updated_at ASC, id ASC) AS seq
         FROM document
       ) ranked WHERE ranked.id = document.id
     )`,
    "UPDATE space_metadata SET change_seq = (SELECT COUNT(*) FROM document)",
  ]);
}

export const spaceMigrations: Migration[] = [
  { id: 1, name: "baseline", up: baseline },
  { id: 2, name: "document-change-seq", up: documentChangeSeq },
];
