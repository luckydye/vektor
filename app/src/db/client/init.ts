import { eq, isNull, sql } from "drizzle-orm";
import * as authSchema from "#db/schema/auth.ts";
import * as spaceSchema from "#db/schema/space.ts";
import { lastMessageRoleOf } from "#db/space/aiChatSessions.ts";
import type { Database } from "./connection.ts";
import { exec, many } from "./query.ts";
import {
  addColumnIfMissing,
  generateCreateTableSQL,
  renameColumnIfNeeded,
} from "./schemaUtils.ts";

export async function prepareAuthDb(authDb: Database) {
  const userSQL = generateCreateTableSQL(authSchema.user);
  const sessionSQL = generateCreateTableSQL(authSchema.session);
  const accountSQL = generateCreateTableSQL(authSchema.account);
  const verificationSQL = generateCreateTableSQL(authSchema.verification);
  const spaceIndexSQL = generateCreateTableSQL(authSchema.spaceIndex);

  await exec(authDb, sql.raw(userSQL));
  await exec(authDb, sql.raw(sessionSQL));
  await exec(authDb, sql.raw(accountSQL));
  await exec(authDb, sql.raw(verificationSQL));
  await exec(authDb, sql.raw(spaceIndexSQL));
  await renameColumnIfNeeded(authDb, authSchema.spaceIndex.location, "database_url");
  await separateDuplicateActiveSpaceSlugs(authDb);
  await exec(
    authDb,
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS space_index_active_slug_unique ON space_index (slug) WHERE status = 'active'",
    ),
  );
}

/**
 * Give every active space its own slug, so the unique index below can be built.
 *
 * `PATCH /api/v1/spaces/:id` used to store any string it was handed, uniqueness
 * unchecked, so a database written by an older build can hold two active spaces
 * on one slug — and `CREATE UNIQUE INDEX` over those rows fails, which would
 * stop the server from starting at all rather than repairing anything.
 *
 * This only pulls the rows apart; `repairSpaceSlugs` then derives a slug that
 * reads properly and writes it back to the space's own database too.
 */
async function separateDuplicateActiveSpaceSlugs(authDb: Database): Promise<void> {
  const duplicateCount = async () =>
    (
      await many<{ total: number }>(
        authDb,
        sql.raw(
          `SELECT COUNT(*) AS total FROM (
             SELECT slug FROM space_index
             WHERE status = 'active' AND slug IS NOT NULL
             GROUP BY slug HAVING COUNT(*) > 1
           )`,
        ),
      )
    )[0]?.total ?? 0;

  // A suffixed slug can itself collide with a slug another row already holds,
  // so this repeats until the column is clean rather than assuming one pass.
  for (let attempt = 0; attempt < 8 && (await duplicateCount()) > 0; attempt++) {
    await exec(
      authDb,
      sql.raw(
        `UPDATE space_index
         SET slug = slug || '-' || rowid
         WHERE status = 'active' AND slug IS NOT NULL AND rowid NOT IN (
           SELECT MIN(rowid) FROM space_index
           WHERE status = 'active' AND slug IS NOT NULL
           GROUP BY slug
         )`,
      ),
    );
  }
}

export async function applySpaceDbPragmas(spaceDb: Database) {
  // WAL mode: concurrent reads don't block writes, and writes batch into the
  // WAL file without per-transaction fsyncs (synchronous=NORMAL handles this).
  await exec(spaceDb, sql.raw("PRAGMA journal_mode = WAL"));
  await exec(spaceDb, sql.raw("PRAGMA synchronous = NORMAL"));
  // Keeps the WAL file small; auto-checkpoint at 1000 pages (default).
  await exec(spaceDb, sql.raw("PRAGMA wal_autocheckpoint = 1000"));
}

/**
 * Derive `last_message_role` for sessions stored before the column existed.
 *
 * Reading those transcripts once is the price of never reading them on the list
 * path. Rows that resolve to null — an empty or unreadable history — are simply
 * retried on the next open, which is what makes this safe to interrupt.
 */
async function backfillAIChatSessionRoles(spaceDb: Database) {
  const rows = await spaceDb
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
      // An unreadable transcript is not worth failing the connection open over.
    }
    if (!role) continue;

    await spaceDb
      .update(spaceSchema.aiChatSession)
      .set({ lastMessageRole: role })
      .where(eq(spaceSchema.aiChatSession.id, row.id));
  }
}

/**
 * Create a space database's tables and indexes from the Drizzle schema.
 *
 * Every statement is conditional, so this is idempotent — it runs on every
 * connection open, not just the first. New tables are created as defined; a
 * column added to an existing table is reconciled with `addColumnIfMissing`.
 */
export async function initSpaceDbSchema(spaceDb: Database, options: { local: boolean }) {
  if (options.local) await applySpaceDbPragmas(spaceDb);

  const metadataSQL = generateCreateTableSQL(spaceSchema.spaceMetadata);
  const documentSQL = generateCreateTableSQL(spaceSchema.document);
  const revisionSQL = generateCreateTableSQL(spaceSchema.revision);
  const propertySQL = generateCreateTableSQL(spaceSchema.property);
  const categorySQL = generateCreateTableSQL(spaceSchema.category);

  await exec(spaceDb, sql.raw(metadataSQL));
  await exec(spaceDb, sql.raw(documentSQL));
  await exec(spaceDb, sql.raw(revisionSQL));
  await exec(spaceDb, sql.raw(propertySQL));
  await exec(spaceDb, sql.raw(categorySQL));

  await exec(
    spaceDb,
    sql.raw(
      "CREATE INDEX IF NOT EXISTS document_updated_at_idx ON document (updated_at DESC)",
    ),
  );
  await exec(
    spaceDb,
    sql.raw("CREATE INDEX IF NOT EXISTS document_parent_id_idx ON document (parent_id)"),
  );
  await exec(
    spaceDb,
    sql.raw(
      "CREATE INDEX IF NOT EXISTS document_workflow_run_parent_created_idx ON document (parent_id, created_at DESC) WHERE type = 'workflow-run'",
    ),
  );
  await exec(
    spaceDb,
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS property_document_id_key_unique ON property (document_id, key)",
    ),
  );

  const preferenceSQL = generateCreateTableSQL(spaceSchema.preference);
  await exec(spaceDb, sql.raw(preferenceSQL));

  const extensionSQL = generateCreateTableSQL(spaceSchema.extension);
  await exec(spaceDb, sql.raw(extensionSQL));

  const commentsSQL = generateCreateTableSQL(spaceSchema.comment);
  await exec(spaceDb, sql.raw(commentsSQL));

  const aclSQL = generateCreateTableSQL(spaceSchema.acl);
  await exec(spaceDb, sql.raw(aclSQL));

  const auditLogSQL = generateCreateTableSQL(spaceSchema.auditLog);
  await exec(spaceDb, sql.raw(auditLogSQL));
  await exec(
    spaceDb,
    sql.raw(
      "CREATE INDEX IF NOT EXISTS audit_log_doc_id_created_at_idx ON audit_log (doc_id, created_at DESC, id DESC)",
    ),
  );
  await exec(
    spaceDb,
    sql.raw(
      "CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC, id DESC)",
    ),
  );

  const emailNotificationOutboxSQL = generateCreateTableSQL(
    spaceSchema.emailNotificationOutbox,
  );
  await exec(spaceDb, sql.raw(emailNotificationOutboxSQL));
  await exec(
    spaceDb,
    sql.raw(
      "CREATE UNIQUE INDEX IF NOT EXISTS email_notification_outbox_event_recipient_unique ON email_notification_outbox (kind, source_id, recipient_user_id)",
    ),
  );
  await exec(
    spaceDb,
    sql.raw(
      "CREATE INDEX IF NOT EXISTS email_notification_outbox_due_idx ON email_notification_outbox (status, available_at)",
    ),
  );

  const accessTokenSQL = generateCreateTableSQL(spaceSchema.accessToken);
  await exec(spaceDb, sql.raw(accessTokenSQL));

  const aiChatSessionSQL = generateCreateTableSQL(spaceSchema.aiChatSession);
  await exec(spaceDb, sql.raw(aiChatSessionSQL));
  await addColumnIfMissing(spaceDb, spaceSchema.aiChatSession.lastMessageRole);
  await backfillAIChatSessionRoles(spaceDb);

  const workflowScheduleSQL = generateCreateTableSQL(spaceSchema.workflowSchedule);
  await exec(spaceDb, sql.raw(workflowScheduleSQL));
  await exec(
    spaceDb,
    sql.raw(
      "CREATE INDEX IF NOT EXISTS workflow_schedule_next_run_at_idx ON workflow_schedule (enabled, next_run_at)",
    ),
  );

  const jobRunSQL = generateCreateTableSQL(spaceSchema.jobRun);
  await exec(spaceDb, sql.raw(jobRunSQL));
  await exec(
    spaceDb,
    sql.raw("CREATE INDEX IF NOT EXISTS job_run_queued_at_idx ON job_run (queued_at)"),
  );

  const spaceSecretSQL = generateCreateTableSQL(spaceSchema.spaceSecret);
  await exec(spaceDb, sql.raw(spaceSecretSQL));
  const oauthIntegrationSQL = generateCreateTableSQL(spaceSchema.oauthIntegration);
  await exec(spaceDb, sql.raw(oauthIntegrationSQL));
  const oauthIntegrationStateSQL = generateCreateTableSQL(
    spaceSchema.oauthIntegrationState,
  );
  await exec(spaceDb, sql.raw(oauthIntegrationStateSQL));

  const fileSQL = generateCreateTableSQL(spaceSchema.file);
  await exec(spaceDb, sql.raw(fileSQL));
}
