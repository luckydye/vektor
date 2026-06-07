import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig } from "drizzle-orm/sqlite-core";

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
  references?: () => { table: SQLiteTable; name: string };
  onDelete?: string;
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

    if (col.notNull) {
      def += " NOT NULL";
    }

    if (col.hasDefault) {
      if (col.default !== undefined) {
        if (typeof col.default === "string") {
          def += ` DEFAULT '${col.default}'`;
        } else if (typeof col.default === "number") {
          def += ` DEFAULT ${col.default}`;
        } else if (typeof col.default === "boolean") {
          def += ` DEFAULT ${col.default ? 1 : 0}`;
        }
      }
    }

    if (col.isUnique) {
      def += " UNIQUE";
    }

    columnDefs.push(def);

    // Handle foreign keys from column references
    if (col.references) {
      const refFn = col.references;
      const refCol = refFn();
      const refTable = getTableConfig(refCol.table).name;
      const refColName = refCol.name;

      let fkDef = `FOREIGN KEY (${col.name}) REFERENCES ${refTable}(${refColName})`;

      // Check for onDelete in column config
      if (col.onDelete) {
        fkDef += ` ON DELETE ${col.onDelete.toUpperCase()}`;
      }

      foreignKeys.push(fkDef);
    }
  }

  const allDefs = [...columnDefs, ...foreignKeys, ...constraints];
  return `CREATE TABLE IF NOT EXISTS ${config.name} (\n  ${allDefs.join(",\n  ")}\n)`;
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

  if (colType.includes("Real")) {
    return "REAL";
  }

  if (colType.includes("Blob")) {
    return "BLOB";
  }

  // Default to TEXT for unknown types
  return "TEXT";
}
