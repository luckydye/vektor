/**
 * One local SQLite connection, run on its own thread.
 *
 * libsql reads `file:` databases synchronously behind an async API, so on the
 * main thread every query froze the whole process — static files, websockets
 * and other spaces included — for as long as the slowest query took. Here a
 * worker owns a libsql client and executes what `workerClient.ts` sends it, in
 * the order it was sent.
 */

import {
  type Client,
  createClient,
  type InArgs,
  type InStatement,
  LibsqlBatchError,
  LibsqlError,
  type Transaction,
} from "@libsql/client";
import {
  type DatabaseRequest,
  type DatabaseResponse,
  type WireError,
  type WireResultSet,
  type WireStatement,
  wireResultSet,
} from "./databaseWorkerProtocol.ts";

declare const self: Worker;

/**
 * How long a write waits for another connection's lock before failing with
 * `SQLITE_BUSY`. libsql's default is to fail at once, which a single thread
 * never noticed: two of its writes could not overlap. On threads they do, and
 * a transaction holds the write lock until it commits.
 */
const BUSY_TIMEOUT_MS = 5_000;

let client: Client | null = null;
let openError: unknown = null;
let tx: Transaction | null = null;

function connection(): Client {
  if (openError) throw openError;
  if (!client) throw new Error("The database worker has not been opened");
  return client;
}

function transaction(): Transaction {
  if (!tx) throw new LibsqlError("The transaction is closed", "TRANSACTION_CLOSED");
  return tx;
}

/** Structured clone hands a Buffer over as a plain Uint8Array; libsql binds Buffers. */
function toArg(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

function toArgs(args: InArgs | undefined): InArgs | undefined {
  if (args === undefined) return undefined;
  if (Array.isArray(args)) return args.map(toArg) as InArgs;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, toArg(v)]),
  ) as InArgs;
}

function toStatement(stmt: WireStatement): InStatement {
  if (typeof stmt === "string") return stmt;
  if (Array.isArray(stmt)) return { sql: stmt[0], args: toArgs(stmt[1]) ?? [] };
  return { sql: stmt.sql, args: toArgs(stmt.args) ?? [] };
}

function toWireError(error: unknown): WireError {
  if (error instanceof LibsqlError) {
    const prefix = `${error.code}: `;
    return {
      name: error.name,
      // LibsqlError prepends the code; the main thread's constructor adds it again.
      message: error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message,
      code: error.code,
      extendedCode: error.extendedCode,
      rawCode: error.rawCode,
      statementIndex:
        error instanceof LibsqlBatchError ? error.statementIndex : undefined,
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

async function run(
  request: DatabaseRequest,
): Promise<WireResultSet | WireResultSet[] | null> {
  switch (request.op) {
    case "open":
      try {
        client = createClient({
          url: request.url,
          authToken: request.authToken,
          timeout: BUSY_TIMEOUT_MS,
        });
      } catch (error) {
        // Kept rather than thrown once: every later request fails with it.
        openError = error;
        throw error;
      }
      return null;
    case "execute":
      return wireResultSet(await connection().execute(toStatement(request.stmt)));
    case "batch":
      return (await connection().batch(request.stmts.map(toStatement), request.mode)).map(
        wireResultSet,
      );
    case "migrate":
      return (await connection().migrate(request.stmts.map(toStatement))).map(
        wireResultSet,
      );
    case "executeMultiple":
      await connection().executeMultiple(request.sql);
      return null;
    case "transaction":
      if (tx) throw new Error("This database worker already holds a transaction");
      tx = await connection().transaction(request.mode);
      return null;
    case "txExecute":
      return wireResultSet(await transaction().execute(toStatement(request.stmt)));
    case "txBatch":
      return (await transaction().batch(request.stmts.map(toStatement))).map(
        wireResultSet,
      );
    case "txExecuteMultiple":
      await transaction().executeMultiple(request.sql);
      return null;
    case "commit":
      // A failed commit leaves the transaction open for the rollback that follows.
      await transaction().commit();
      tx = null;
      return null;
    case "rollback":
      try {
        await transaction().rollback();
      } finally {
        tx = null;
      }
      return null;
    case "txClose":
      try {
        transaction().close();
      } finally {
        tx = null;
      }
      return null;
    case "close":
      tx?.close();
      tx = null;
      client?.close();
      client = null;
      return null;
  }
}

// Chained, so requests run strictly in arrival order even across awaits.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<DatabaseRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    let response: DatabaseResponse;
    try {
      response = { id: request.id, ok: true, result: await run(request) };
    } catch (error) {
      response = { id: request.id, ok: false, error: toWireError(error) };
    }
    self.postMessage(response);
  });
};
