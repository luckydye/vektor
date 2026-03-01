import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import * as authSchema from "./schema/auth.ts";
import * as spaceSchema from "./schema/space.ts";
import { generateCreateTableSQL } from "./schemaUtils.ts";

const DATA_DIR = "./data";

export async function prepateAuthDb(authDb: LibSQLDatabase) {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // Generate CREATE TABLE statements from Drizzle schemas
  const userSQL = generateCreateTableSQL(authSchema.user);
  const sessionSQL = generateCreateTableSQL(authSchema.session);
  const accountSQL = generateCreateTableSQL(authSchema.account);
  const verificationSQL = generateCreateTableSQL(authSchema.verification);

  // Execute table creation
  await authDb.run(sql.raw(userSQL));
  await authDb.run(sql.raw(sessionSQL));
  await authDb.run(sql.raw(accountSQL));
  await authDb.run(sql.raw(verificationSQL));

  console.log("Auth database initialized at");
}

export async function prepareSpaceDb(spaceId: string) {
  const spacePath = join(DATA_DIR, "spaces", `${spaceId}.db`);
  const spaceDir = join(DATA_DIR, "spaces");

  if (!existsSync(spaceDir)) {
    mkdirSync(spaceDir, { recursive: true });
  }

  const spaceDb = drizzle({
    connection: {
      url: `file:${path.resolve(spacePath)}`,
    },
  });

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

  const preferenceSQL = generateCreateTableSQL(spaceSchema.preference);
  await spaceDb.run(sql.raw(preferenceSQL));

  const extensionSQL = generateCreateTableSQL(spaceSchema.extension);
  await spaceDb.run(sql.raw(extensionSQL));

  const extensionStorageSQL = generateCreateTableSQL(spaceSchema.extensionStorage);
  await spaceDb.run(sql.raw(extensionStorageSQL));

  const commentsSQL = generateCreateTableSQL(spaceSchema.comment);
  await spaceDb.run(sql.raw(commentsSQL));

  const aclSQL = generateCreateTableSQL(spaceSchema.acl);
  await spaceDb.run(sql.raw(aclSQL));

  const auditLogSQL = generateCreateTableSQL(spaceSchema.auditLog);
  await spaceDb.run(sql.raw(auditLogSQL));

  const webhookSQL = generateCreateTableSQL(spaceSchema.webhook);
  await spaceDb.run(sql.raw(webhookSQL));

  const accessTokenSQL = generateCreateTableSQL(spaceSchema.accessToken);
  await spaceDb.run(sql.raw(accessTokenSQL));

  const spaceSecretSQL = generateCreateTableSQL(spaceSchema.spaceSecret);
  await spaceDb.run(sql.raw(spaceSecretSQL));

  await spaceDb.run(
    sql.raw(`
			CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
				title,
				properties,
				content
			)
		`),
  );

  await spaceDb.run(
    sql.raw(`
			CREATE TRIGGER IF NOT EXISTS document_ai AFTER INSERT ON document BEGIN
				INSERT INTO document_fts(rowid, title, properties, content)
				VALUES (
					new.rowid,
					COALESCE((SELECT value FROM property WHERE document_id = new.id AND key = 'title'), ''),
					COALESCE((SELECT GROUP_CONCAT(key || ': ' || value, ' ') FROM property WHERE document_id = new.id), ''),
					new.content
				);
			END
		`),
  );

  await spaceDb.run(
    sql.raw(`
			CREATE TRIGGER IF NOT EXISTS document_ad AFTER DELETE ON document BEGIN
				DELETE FROM document_fts WHERE rowid = old.rowid;
			END
		`),
  );

  await spaceDb.run(
    sql.raw(`
			CREATE TRIGGER IF NOT EXISTS document_au AFTER UPDATE ON document BEGIN
				DELETE FROM document_fts WHERE rowid = old.rowid;
				INSERT INTO document_fts(rowid, title, properties, content)
				VALUES (
					new.rowid,
					COALESCE((SELECT value FROM property WHERE document_id = new.id AND key = 'title'), ''),
					COALESCE((SELECT GROUP_CONCAT(key || ': ' || value, ' ') FROM property WHERE document_id = new.id), ''),
					new.content
				);
			END
		`),
  );

  // Ensure FTS5 virtual table exists (migration for existing spaces)
  try {
    await spaceDb.run(
      sql.raw(`
				CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
					title,
					properties,
					content
				)
			`),
    );

    await spaceDb.run(
      sql.raw(`
				CREATE TRIGGER IF NOT EXISTS document_ai AFTER INSERT ON document BEGIN
					INSERT INTO document_fts(rowid, title, properties, content)
					VALUES (
						new.rowid,
						COALESCE((SELECT value FROM property WHERE document_id = new.id AND key = 'title'), ''),
						COALESCE((SELECT GROUP_CONCAT(key || ': ' || value, ' ') FROM property WHERE document_id = new.id), ''),
						new.content
					);
				END
			`),
    );

    await spaceDb.run(
      sql.raw(`
				CREATE TRIGGER IF NOT EXISTS document_ad AFTER DELETE ON document BEGIN
					DELETE FROM document_fts WHERE rowid = old.rowid;
				END
			`),
    );

    await spaceDb.run(
      sql.raw(`
				CREATE TRIGGER IF NOT EXISTS document_au AFTER UPDATE ON document BEGIN
					DELETE FROM document_fts WHERE rowid = old.rowid;
					INSERT INTO document_fts(rowid, title, properties, content)
					VALUES (
						new.rowid,
						COALESCE((SELECT value FROM property WHERE document_id = new.id AND key = 'title'), ''),
						COALESCE((SELECT GROUP_CONCAT(key || ': ' || value, ' ') FROM property WHERE document_id = new.id), ''),
						new.content
					);
				END
			`),
    );

    // Check if we need to populate the FTS table (only if not migrated above)
    let ftsCount = 0;
    let docCount = 0;

    try {
      const ftsResult = await spaceDb.get<{ count: number }>(
        sql.raw("SELECT COUNT(*) as count FROM document_fts"),
      );
      ftsCount = ftsResult?.count ?? 0;
    } catch {
      // FTS table might not exist yet
      ftsCount = 0;
    }

    const docResult = await spaceDb.get<{ count: number }>(
      sql.raw("SELECT COUNT(*) as count FROM document"),
    );
    docCount = docResult?.count ?? 0;

    if (docCount > 0 && ftsCount === 0) {
      console.log(`Populating FTS table for space ${spaceId} (${docCount} documents)...`);

      const docs = await spaceDb.select().from(spaceSchema.document).all();

      for (const doc of docs) {
        const props = await spaceDb
          .select()
          .from(spaceSchema.property)
          .where(eq(spaceSchema.property.documentId, doc.id))
          .all();

        const titleProp = props.find((p) => p.key === "title");
        const propsText = props.map((p) => `${p.key}: ${p.value}`).join(" ");

        await spaceDb.run(sql`
						INSERT INTO document_fts(rowid, title, properties, content)
						VALUES (
							(SELECT rowid FROM document WHERE id = ${doc.id}),
							${titleProp?.value || ""},
							${propsText},
							${doc.content}
						)
					`);
      }

      console.log(`FTS population complete for space ${spaceId}`);
    }
  } catch (err) {
    console.error("Failed to create FTS5 table:", err);
  }

  console.log("Space database initialized at:", spacePath);
}
