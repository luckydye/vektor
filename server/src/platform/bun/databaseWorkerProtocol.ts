/**
 * What crosses between `workerClient.ts` on the main thread and the connection
 * threads of `databaseWorker.ts`. Kept apart from both: the worker module sets
 * up a client as it loads and must never be imported here, and the main module
 * pulls in the server's config.
 */

import type { InArgs, InStatement, ResultSet, TransactionMode } from "@libsql/client";

/** A statement as it crosses to the worker; libsql's tuple form included. */
export type WireStatement = InStatement | [string, InArgs?];

export type DatabaseRequest = { id: number } & (
  | { op: "open"; url: string; authToken?: string }
  | { op: "execute"; stmt: InStatement }
  | { op: "batch"; stmts: WireStatement[]; mode?: TransactionMode }
  | { op: "migrate"; stmts: InStatement[] }
  | { op: "executeMultiple"; sql: string }
  | { op: "transaction"; mode?: TransactionMode }
  | { op: "txExecute"; stmt: InStatement }
  | { op: "txBatch"; stmts: InStatement[] }
  | { op: "txExecuteMultiple"; sql: string }
  | { op: "commit" | "rollback" | "txClose" | "close" }
);

/** A result set with plain rows: libsql's rows keep their values in non-enumerable keys, which structured clone drops. */
export interface WireResultSet {
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
}

export interface WireError {
  name: string;
  message: string;
  code?: string;
  extendedCode?: string;
  rawCode?: number;
  statementIndex?: number;
}

export type DatabaseResponse = { id: number } & (
  | { ok: true; result: WireResultSet | WireResultSet[] | null }
  | { ok: false; error: WireError }
);

/** Rebuilds `ResultSet`'s shape from what crossed, for a caller that wants one. */
export type WireResult = (DatabaseResponse & { ok: true })["result"];

export function wireResultSet(result: ResultSet): WireResultSet {
  return {
    columns: result.columns,
    columnTypes: result.columnTypes,
    rows: result.rows.map((row) => Array.from(row as ArrayLike<unknown>)),
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid,
  };
}
