import { sql } from "drizzle-orm";
import * as authSchema from "#db/schema/auth.ts";
import * as spaceSchema from "#db/schema/space.ts";
import type { Database } from "./connection.ts";
import { generateCreateTableSQL } from "./schemaUtils.ts";

export async function prepareAuthDb(authDb: Database) {
  const userSQL = generateCreateTableSQL(authSchema.user);
  const sessionSQL = generateCreateTableSQL(authSchema.session);
  const accountSQL = generateCreateTableSQL(authSchema.account);
  const verificationSQL = generateCreateTableSQL(authSchema.verification);
  const spaceIndexSQL = generateCreateTableSQL(authSchema.spaceIndex);

  await authDb.run(sql.raw(userSQL));
  await authDb.run(sql.raw(sessionSQL));
  await authDb.run(sql.raw(accountSQL));
  await authDb.run(sql.raw(verificationSQL));
  await authDb.run(sql.raw(spaceIndexSQL));
  await authDb.run(
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS space_index_active_slug_unique ON space_index (slug) WHERE status = 'active'",
    ),
  );
}

export async function applySpaceDbPragmas(spaceDb: Database) {
  // WAL mode: concurrent reads don't block writes, and writes batch into the
  // WAL file without per-transaction fsyncs (synchronous=NORMAL handles this).
  await spaceDb.run(sql.raw("PRAGMA journal_mode = WAL"));
  await spaceDb.run(sql.raw("PRAGMA synchronous = NORMAL"));
  // Keeps the WAL file small; auto-checkpoint at 1000 pages (default).
  await spaceDb.run(sql.raw("PRAGMA wal_autocheckpoint = 1000"));
}

/**
 * Create a space database's tables and indexes from the Drizzle schema.
 *
 * Every statement is `IF NOT EXISTS`, so this is idempotent — it runs on every
 * connection open, not just the first. It creates the schema as currently
 * defined and does not upgrade databases written by an older schema.
 */
export async function initSpaceDbSchema(spaceDb: Database, options: { local: boolean }) {
  if (options.local) await applySpaceDbPragmas(spaceDb);

  const metadataSQL = generateCreateTableSQL(spaceSchema.spaceMetadata);
  const documentSQL = generateCreateTableSQL(spaceSchema.document);
  const revisionSQL = generateCreateTableSQL(spaceSchema.revision);
  const propertySQL = generateCreateTableSQL(spaceSchema.property);
  const categorySQL = generateCreateTableSQL(spaceSchema.category);

  await spaceDb.run(sql.raw(metadataSQL));
  await spaceDb.run(sql.raw(documentSQL));
  await spaceDb.run(sql.raw(revisionSQL));
  await spaceDb.run(sql.raw(propertySQL));
  await spaceDb.run(sql.raw(categorySQL));

  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS document_updated_at_idx ON document (updated_at DESC)",
    ),
  );
  await spaceDb.run(
    sql.raw("CREATE INDEX IF NOT EXISTS document_parent_id_idx ON document (parent_id)"),
  );
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS document_workflow_run_parent_created_idx ON document (parent_id, created_at DESC) WHERE type = 'workflow-run'",
    ),
  );
  await spaceDb.run(
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS property_document_id_key_unique ON property (document_id, key)",
    ),
  );

  const preferenceSQL = generateCreateTableSQL(spaceSchema.preference);
  await spaceDb.run(sql.raw(preferenceSQL));

  const extensionSQL = generateCreateTableSQL(spaceSchema.extension);
  await spaceDb.run(sql.raw(extensionSQL));

  const commentsSQL = generateCreateTableSQL(spaceSchema.comment);
  await spaceDb.run(sql.raw(commentsSQL));

  const aclSQL = generateCreateTableSQL(spaceSchema.acl);
  await spaceDb.run(sql.raw(aclSQL));

  const auditLogSQL = generateCreateTableSQL(spaceSchema.auditLog);
  await spaceDb.run(sql.raw(auditLogSQL));
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS audit_log_doc_id_created_at_idx ON audit_log (doc_id, created_at DESC, id DESC)",
    ),
  );
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC, id DESC)",
    ),
  );

  const emailNotificationOutboxSQL = generateCreateTableSQL(
    spaceSchema.emailNotificationOutbox,
  );
  await spaceDb.run(sql.raw(emailNotificationOutboxSQL));
  await spaceDb.run(
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS email_notification_outbox_event_recipient_unique ON email_notification_outbox (kind, source_id, recipient_user_id)",
    ),
  );
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS email_notification_outbox_due_idx ON email_notification_outbox (status, available_at)",
    ),
  );

  const accessTokenSQL = generateCreateTableSQL(spaceSchema.accessToken);
  await spaceDb.run(sql.raw(accessTokenSQL));

  const aiChatSessionSQL = generateCreateTableSQL(spaceSchema.aiChatSession);
  await spaceDb.run(sql.raw(aiChatSessionSQL));

  const workflowScheduleSQL = generateCreateTableSQL(spaceSchema.workflowSchedule);
  await spaceDb.run(sql.raw(workflowScheduleSQL));
  await spaceDb.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS workflow_schedule_next_run_at_idx ON workflow_schedule (enabled, next_run_at)",
    ),
  );

  const jobRunSQL = generateCreateTableSQL(spaceSchema.jobRun);
  await spaceDb.run(sql.raw(jobRunSQL));
  await spaceDb.run(
    sql.raw("CREATE INDEX IF NOT EXISTS job_run_queued_at_idx ON job_run (queued_at)"),
  );

  const spaceSecretSQL = generateCreateTableSQL(spaceSchema.spaceSecret);
  await spaceDb.run(sql.raw(spaceSecretSQL));
  const oauthIntegrationSQL = generateCreateTableSQL(spaceSchema.oauthIntegration);
  await spaceDb.run(sql.raw(oauthIntegrationSQL));
  const oauthIntegrationStateSQL = generateCreateTableSQL(
    spaceSchema.oauthIntegrationState,
  );
  await spaceDb.run(sql.raw(oauthIntegrationStateSQL));

  const fileSQL = generateCreateTableSQL(spaceSchema.file);
  await spaceDb.run(sql.raw(fileSQL));
}
