import { existsSync, mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { sql } from "drizzle-orm";
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
  await spaceDb.run(sql.raw("DROP TABLE IF EXISTS extension_storage"));

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
  const oauthIntegrationSQL = generateCreateTableSQL(spaceSchema.oauthIntegration);
  await spaceDb.run(sql.raw(oauthIntegrationSQL));
  const oauthIntegrationStateSQL = generateCreateTableSQL(
    spaceSchema.oauthIntegrationState,
  );
  await spaceDb.run(sql.raw(oauthIntegrationStateSQL));
  await spaceDb.run(
    sql.raw("ALTER TABLE oauth_integration ADD COLUMN instance_url TEXT"),
  ).catch(() => {});
  await spaceDb.run(
    sql.raw("ALTER TABLE oauth_integration_state ADD COLUMN instance_url TEXT"),
  ).catch(() => {});

  await spaceDb.run(sql.raw("ALTER TABLE document ADD COLUMN search_text TEXT")).catch(() => {});
  await spaceDb.run(sql.raw("ALTER TABLE document ADD COLUMN search_embedding TEXT")).catch(
    () => {},
  );
  await spaceDb.run(
    sql.raw("ALTER TABLE document ADD COLUMN search_updated_at INTEGER"),
  ).catch(() => {});

  try {
    await spaceDb.run(sql.raw("DROP TRIGGER IF EXISTS document_ai"));
    await spaceDb.run(sql.raw("DROP TRIGGER IF EXISTS document_ad"));
    await spaceDb.run(sql.raw("DROP TRIGGER IF EXISTS document_au"));
    await spaceDb.run(sql.raw("DROP TABLE IF EXISTS document_fts"));
  } catch (err) {
    console.error("Failed to prepare vector search schema:", err);
  }

  console.log("Space database initialized at:", spacePath);
}
