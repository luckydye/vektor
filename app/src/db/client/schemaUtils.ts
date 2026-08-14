import { sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { Database } from "./connection.ts";
import { exec } from "./query.ts";

/** The subset of drizzle's internal column shape this generator reads. */
interface ColumnInfo {
  name: string;
  columnType: string;
  primary?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  hasDefault?: boolean;
  default?: unknown;
  isUnique?: boolean;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function generateCreateTableSQL(table: SQLiteTable): string {
  const config = getTableConfig(table);
  const columns = config.columns;

  const columnDefs: string[] = [];
  const foreignKeys: string[] = [];
  const constraints: string[] = [];

  // Check for composite primary key
  if (config.primaryKeys && config.primaryKeys.length > 0) {
    const pkColumns = config.primaryKeys[0].columns.map((col) => col.name);
    constraints.push(`PRIMARY KEY (${pkColumns.join(", ")})`);
  }

  for (const column of columns) {
    const col = column as unknown as ColumnInfo;
    let def = `"${col.name}" ${getSQLiteType(col)}`;

    // Only add PRIMARY KEY if there's no composite primary key
    if (col.primary && (!config.primaryKeys || config.primaryKeys.length === 0)) {
      def += " PRIMARY KEY";
      // Add AUTOINCREMENT for integer primary keys
      if (col.autoIncrement) {
        def += " AUTOINCREMENT";
      }
    }

    def += columnConstraints(col);

    columnDefs.push(def);
  }

  // Drizzle stores references on the table, not on the individual column.
  // Reading the column shape silently omitted every FK from generated tables.
  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    const localColumns = reference.columns.map((column) =>
      quoteIdentifier(column.name),
    );
    const foreignColumns = reference.foreignColumns.map((column) =>
      quoteIdentifier(column.name),
    );
    const foreignTable = quoteIdentifier(getTableConfig(reference.foreignTable).name);

    let definition = `FOREIGN KEY (${localColumns.join(", ")}) REFERENCES ${foreignTable}(${foreignColumns.join(", ")})`;
    if (foreignKey.onDelete) {
      definition += ` ON DELETE ${foreignKey.onDelete.toUpperCase()}`;
    }
    if (foreignKey.onUpdate) {
      definition += ` ON UPDATE ${foreignKey.onUpdate.toUpperCase()}`;
    }
    foreignKeys.push(definition);
  }

  const allDefs = [...columnDefs, ...foreignKeys, ...constraints];
  return `CREATE TABLE IF NOT EXISTS ${config.name} (\n  ${allDefs.join(",\n  ")}\n)`;
}

/** The constraints trailing a column's type, shared by CREATE TABLE and ADD COLUMN. */
function columnConstraints(col: ColumnInfo): string {
  let constraints = "";

  if (col.notNull) {
    constraints += " NOT NULL";
  }

  if (col.hasDefault) {
    if (col.default !== undefined) {
      if (typeof col.default === "string") {
        constraints += ` DEFAULT '${col.default}'`;
      } else if (typeof col.default === "number") {
        constraints += ` DEFAULT ${col.default}`;
      } else if (typeof col.default === "boolean") {
        constraints += ` DEFAULT ${col.default ? 1 : 0}`;
      }
    }
  }

  if (col.isUnique) {
    constraints += " UNIQUE";
  }

  return constraints;
}

/**
 * Probed with a SELECT rather than the dialect's introspection table: every SQL
 * database rejects an unknown column, and none of them agree on how to ask.
 */
async function columnExists(
  db: Database,
  table: string,
  column: string,
): Promise<boolean> {
  try {
    await exec(db, sql.raw(`SELECT "${column}" FROM ${table} LIMIT 0`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Add a column an older release's CREATE TABLE did not know about.
 *
 * The column must be nullable or defaulted — that is all `ADD COLUMN` can give
 * the rows already there.
 */
export async function addColumnIfMissing(
  db: Database,
  column: SQLiteColumn,
): Promise<void> {
  const table = getTableConfig(column.table).name;
  const col = column as unknown as ColumnInfo;
  if (await columnExists(db, table, col.name)) return;

  await exec(
    db,
    sql.raw(
      `ALTER TABLE ${table} ADD COLUMN "${col.name}" ${getSQLiteType(col)}${columnConstraints(col)}`,
    ),
  );
}

/**
 * Rename a column an older release created under a different name.
 *
 * Both names are probed, so this is a no-op twice over: on a table already
 * renamed, and on one the current schema just created. `RENAME COLUMN` carries
 * the column's constraints and data with it, which is why the rename is a
 * migration rather than an add-and-backfill.
 */
export async function renameColumnIfNeeded(
  db: Database,
  column: SQLiteColumn,
  formerName: string,
): Promise<void> {
  const table = getTableConfig(column.table).name;
  const col = column as unknown as ColumnInfo;
  if (await columnExists(db, table, col.name)) return;
  if (!(await columnExists(db, table, formerName))) return;

  await exec(
    db,
    sql.raw(`ALTER TABLE ${table} RENAME COLUMN "${formerName}" TO "${col.name}"`),
  );
}

function getSQLiteType(column: ColumnInfo): string {
  const colType = column.columnType;

  // SQLite column types from drizzle-orm
  if (colType.includes("Text")) {
    return "TEXT";
  }

  if (colType.includes("Integer")) {
    return "INTEGER";
  }

  // `integer({ mode })` reports itself as SQLiteTimestamp/SQLiteBoolean rather
  // than SQLiteInteger, and TEXT affinity would store the epoch value as a
  // string — which drizzle reads back for a `timestamp_ms` column as
  // `Invalid Date`, breaking OAuth token refresh (`access_token_expires_at`).
  if (colType.includes("Timestamp") || colType.includes("Boolean")) {
    return "INTEGER";
  }

  if (colType.includes("Real")) {
    return "REAL";
  }

  if (colType.includes("Blob")) {
    return "BLOB";
  }

  // Default to TEXT for unknown types
  return "TEXT";
}
