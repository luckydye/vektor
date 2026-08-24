/**
 * The rebuild that takes `NOT NULL` off `email_notification_outbox.document_id`.
 *
 * SQLite can only drop a column constraint by recreating the table, and this
 * one holds undelivered mail — so the rebuild is worth pinning: the constraint
 * has to be gone and the rows still there.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "#db/client/connection.ts";
import { initSpaceDbSchema } from "#db/client/init.ts";
import { exec, many } from "#db/client/query.ts";

let directory: string | undefined;

/** The table exactly as an earlier release created it. */
const LEGACY_TABLE = `CREATE TABLE email_notification_outbox (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "document_id" TEXT NOT NULL,
  "published_revision" INTEGER,
  "previous_published_revision" INTEGER,
  "actor_id" TEXT NOT NULL,
  "recipient_user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" INTEGER NOT NULL,
  "last_error" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "sent_at" INTEGER
)`;

function openDatabase(): Database {
  directory = mkdtempSync(join(tmpdir(), "vektor-outbox-migration-"));
  return createDatabase(`file:${join(directory, "space.db")}`);
}

afterEach(() => {
  if (directory && existsSync(directory))
    rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("email outbox document_id migration", () => {
  it("drops the constraint and keeps the mail already queued", async () => {
    const db = openDatabase();
    await exec(db, sql.raw(LEGACY_TABLE));
    await exec(
      db,
      sql.raw(
        `INSERT INTO email_notification_outbox (id, kind, source_id, document_id, actor_id, recipient_user_id, status, attempts, available_at, created_at, updated_at)
         VALUES ('n1', 'document_published', 's1', 'doc1', 'u1', 'u2', 'pending', 0, 0, 0, 0)`,
      ),
    );

    await initSpaceDbSchema(db, { local: true });

    const queued = await many<{ id: string; document_id: string | null }>(
      db,
      sql.raw("SELECT id, document_id FROM email_notification_outbox"),
    );
    expect(queued).toEqual([{ id: "n1", document_id: "doc1" }]);

    // An invitation announces the space, so it carries no document at all.
    await exec(
      db,
      sql.raw(
        `INSERT INTO email_notification_outbox (id, kind, source_id, document_id, role, actor_id, recipient_user_id, status, attempts, available_at, created_at, updated_at)
         VALUES ('n2', 'space_invitation', 's2', NULL, 'viewer', 'u1', 'u3', 'pending', 0, 0, 0, 0)`,
      ),
    );

    const rows = await many<{ id: string }>(
      db,
      sql.raw("SELECT id FROM email_notification_outbox ORDER BY id"),
    );
    expect(rows.map((r) => r.id)).toEqual(["n1", "n2"]);
  });

  it("drops the cascade, so a document delete cannot erase the record", async () => {
    const db = openDatabase();
    await exec(db, sql.raw(LEGACY_TABLE));
    await initSpaceDbSchema(db, { local: true });

    await exec(
      db,
      sql.raw(
        `INSERT INTO document (id, slug, content, archived, readonly, current_rev, created_at, updated_at, created_by)
         VALUES ('d1', 'a-doc', '', 0, 0, 0, 0, 0, 'u1')`,
      ),
    );
    await exec(
      db,
      sql.raw(
        `INSERT INTO email_notification_outbox (id, kind, source_id, document_id, actor_id, recipient_user_id, status, attempts, available_at, created_at, updated_at)
         VALUES ('n1', 'document_published', 's1', 'd1', 'u1', 'u2', 'sent', 0, 0, 0, 0)`,
      ),
    );

    await exec(db, sql.raw("DELETE FROM document WHERE id = 'd1'"));

    const rows = await many<{ id: string; status: string }>(
      db,
      sql.raw("SELECT id, status FROM email_notification_outbox"),
    );
    expect(rows).toEqual([{ id: "n1", status: "sent" }]);
  });

  it("leaves an already-migrated table alone", async () => {
    const db = openDatabase();
    await initSpaceDbSchema(db, { local: true });
    await initSpaceDbSchema(db, { local: true });

    const tables = await many<{ name: string }>(
      db,
      sql.raw(
        "SELECT name FROM sqlite_master WHERE name LIKE 'email_notification_outbox%'",
      ),
    );
    expect(tables.map((t) => t.name)).toContain("email_notification_outbox");
    expect(tables.map((t) => t.name)).not.toContain("email_notification_outbox_new");
  });
});
