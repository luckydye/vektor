/**
 * A libsql `Client` for a local database whose queries run on worker threads
 * (`databaseWorker.ts`), so a slow query no longer blocks the event loop.
 *
 * WAL lets one writer and any number of readers work at once, so a database
 * gets a writer thread and up to `MAX_READERS` reader threads, each with its
 * own connection. Writes and transactions take turns on the writer; reads never
 * wait for them. A statement sees everything awaited before it, the same
 * guarantee a hosted libsql database gives; statements in flight together run
 * in no promised order.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Client,
  type InArgs,
  type InStatement,
  LibsqlBatchError,
  LibsqlError,
  type Replicated,
  type ResultSet,
  type Row,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { appLogger } from "#observability/logger.ts";
import type {
  DatabaseRequest,
  DatabaseResponse,
  WireError,
  WireResult,
  WireResultSet,
  WireStatement,
} from "./databaseWorkerProtocol.ts";

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
type Request = WithoutId<DatabaseRequest>;
type Result = WireResult;

/**
 * In the compiled binary `build.ts` bundles the worker as an entrypoint of its
 * own, at its source path; from source it is loaded as is.
 */
function workerUrl(): URL {
  return import.meta.url.includes("$bunfs")
    ? new URL("./src/platform/bun/databaseWorker.js", import.meta.url)
    : new URL("./databaseWorker.ts", import.meta.url);
}

function toError(error: WireError): Error {
  if (error.code !== undefined) {
    return error.statementIndex !== undefined
      ? new LibsqlBatchError(
          error.message,
          error.statementIndex,
          error.code,
          error.extendedCode,
          error.rawCode,
        )
      : new LibsqlError(error.message, error.code, error.extendedCode, error.rawCode);
  }
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

/**
 * A prototype answering a row's `length` and its values by index from its named
 * properties, so a row is built by plain assignment instead of one
 * `defineProperty` per value — which on large listings cost the main thread
 * more than the query did. Null where a name could stand for two columns or
 * shadow an index or `length`; those rows are built the way libsql builds them.
 */
function rowPrototype(columns: string[]): object | null {
  if (
    new Set(columns).size !== columns.length ||
    columns.some((column) => column === "length" || /^\d+$/.test(column))
  ) {
    return null;
  }
  const prototype = {};
  Object.defineProperty(prototype, "length", { value: columns.length });
  columns.forEach((column, index) => {
    Object.defineProperty(prototype, index, {
      get(this: Record<string, unknown>) {
        return this[column];
      },
    });
  });
  return prototype;
}

function toPrototypedRow(values: unknown[], columns: string[], prototype: object): Row {
  const row: Record<string, unknown> = Object.create(prototype);
  for (let i = 0; i < values.length; i++) row[columns[i] as string] = values[i];
  return row as Row;
}

/** Rebuilds a row the way libsql builds it: values by index (not enumerable) and by column name. */
function toRow(values: unknown[], columns: string[]): Row {
  const row = {};
  Object.defineProperty(row, "length", { value: values.length });
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    Object.defineProperty(row, i, { value });
    const column = columns[i] as string;
    if (!Object.hasOwn(row, column)) {
      Object.defineProperty(row, column, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return row as Row;
}

function toResultSet(wire: WireResultSet): ResultSet {
  const prototype = wire.rows.length > 0 ? rowPrototype(wire.columns) : null;
  return {
    columns: wire.columns,
    columnTypes: wire.columnTypes,
    rows: wire.rows.map((values) =>
      prototype
        ? toPrototypedRow(values, wire.columns, prototype)
        : toRow(values, wire.columns),
    ),
    rowsAffected: wire.rowsAffected,
    lastInsertRowid: wire.lastInsertRowid,
    toJSON: () => ({
      columns: wire.columns,
      columnTypes: wire.columnTypes,
      rows: wire.rows,
      rowsAffected: wire.rowsAffected,
      lastInsertRowid: wire.lastInsertRowid?.toString() ?? null,
    }),
  };
}

function toStatement(stmtOrSql: InStatement, args?: InArgs): InStatement {
  return typeof stmtOrSql === "string" ? { sql: stmtOrSql, args: args ?? [] } : stmtOrSql;
}

function single(result: Result): ResultSet {
  if (result === null || Array.isArray(result)) {
    throw new Error("Expected one result set from the database worker");
  }
  return toResultSet(result);
}

function many(result: Result): ResultSet[] {
  if (!Array.isArray(result)) {
    throw new Error("Expected result sets from the database worker");
  }
  return result.map(toResultSet);
}

/**
 * Bun's worker has `ref`/`unref`; the DOM typings picked up for `Worker` here
 * do not declare them.
 */
interface WorkerRef {
  ref?: () => void;
  unref?: () => void;
}

/** One worker thread holding one libsql client. */
class WorkerConnection {
  readonly worker: Worker;
  readonly ref: (() => void) | undefined;
  readonly unref: (() => void) | undefined;
  readonly pending = new Map<
    number,
    { resolve: (result: Result) => void; reject: (error: Error) => void }
  >();
  nextId = 1;
  /** Set once the worker died or was closed; every request after fails with it. */
  failure: Error | null = null;
  /** Pending release of the process's liveness, cancelled by the next request. */
  idleRelease: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, authToken: string | undefined) {
    this.worker = new Worker(workerUrl(), { type: "module" });
    const { ref, unref } = this.worker as Worker & WorkerRef;
    this.ref = ref?.bind(this.worker);
    this.unref = unref?.bind(this.worker);
    // Only in-flight requests keep the process alive, as a synchronous driver never did on its own.
    this.unref?.();
    this.worker.addEventListener("message", (event: MessageEvent<DatabaseResponse>) => {
      const response = event.data;
      const waiter = this.pending.get(response.id);
      if (!waiter) throw new Error(`Unexpected database worker response ${response.id}`);
      this.pending.delete(response.id);
      if (this.pending.size === 0) this.releaseWhenIdle();
      if (response.ok) waiter.resolve(response.result);
      else waiter.reject(toError(response.error));
    });
    this.worker.addEventListener("error", (event) => {
      this.fail(new Error(`Database worker crashed: ${event.message}`));
    });
    // An open that fails is kept by the worker and fails every request after
    // it, which is where it surfaces; this one has no caller to report to.
    this.request({ op: "open", url, authToken }).catch(() => {});
  }

  request(request: Request): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.idleRelease) {
        clearTimeout(this.idleRelease);
        this.idleRelease = null;
      } else if (this.pending.size === 1) {
        this.ref?.();
      }
      this.worker.postMessage({ id, ...request });
    });
  }

  /**
   * Lets the process exit once the connection has been quiet for a moment. Not
   * per request: a `ref`/`unref` pair on every statement cost more than the
   * statements did, since a request runs a dozen of them.
   */
  releaseWhenIdle(): void {
    this.idleRelease ??= setTimeout(() => {
      this.idleRelease = null;
      if (this.pending.size === 0) this.unref?.();
    }, 1_000);
    this.idleRelease.unref?.();
  }

  fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.worker.terminate();
  }

  /** Runs after whatever was sent before it, then ends the thread. */
  close(): void {
    const closing = this.request({ op: "close" });
    this.failure ??= new Error("The database connection is closed");
    closing.then(
      () => this.worker.terminate(),
      (error: unknown) => {
        appLogger.error("Closing a database worker failed", { error });
        this.worker.terminate();
      },
    );
  }
}

class WorkerTransaction implements Transaction {
  closed = false;
  /** Settles when the transaction is over, however it ended. */
  readonly ended: Promise<void>;
  readonly settle: () => void;

  constructor(
    readonly connection: WorkerConnection,
    /** Called once, when the transaction is over. */
    readonly release: () => void,
  ) {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.ended = promise;
    this.settle = resolve;
  }

  async execute(stmt: InStatement): Promise<ResultSet> {
    return single(await this.connection.request({ op: "txExecute", stmt }));
  }

  async batch(stmts: InStatement[]): Promise<ResultSet[]> {
    return many(await this.connection.request({ op: "txBatch", stmts }));
  }

  async executeMultiple(sql: string): Promise<void> {
    await this.connection.request({ op: "txExecuteMultiple", sql });
  }

  async commit(): Promise<void> {
    // A failed commit keeps the transaction for the rollback that follows it.
    await this.connection.request({ op: "commit" });
    this.end();
  }

  async rollback(): Promise<void> {
    if (this.closed) return;
    try {
      await this.connection.request({ op: "rollback" });
    } finally {
      this.end();
    }
  }

  close(): void {
    if (this.closed) return;
    this.connection.request({ op: "txClose" }).then(
      () => this.end(),
      (error: unknown) => {
        appLogger.error("Closing a database transaction failed", { error });
        this.end();
      },
    );
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.release();
    this.settle();
  }
}

/** The transaction whose body is running, as `runInTransactionBody` marked it. */
const transactionBodies = new AsyncLocalStorage<WorkerTransaction>();

/** Reader threads per database, beside its writer; spawned as reads need them. */
const MAX_READERS = 3;

/** Whether a statement only reads, and so may run on any connection. */
function isRead(stmt: InStatement): boolean {
  return /^\s*select\b/i.test(typeof stmt === "string" ? stmt : stmt.sql);
}

export class WorkerClient implements Client {
  readonly protocol = "file";
  closed = false;
  /** Every write and transaction, one at a time, in the order they are issued. */
  readonly writer: WorkerConnection;
  readonly readers: WorkerConnection[] = [];
  /** The transaction holding the writer; at most one, since writes take turns. */
  active: WorkerTransaction | null = null;

  constructor(
    readonly url: string,
    readonly authToken: string | undefined,
    /**
     * Every `:memory:` connection is a private database, so a second one would
     * see none of the data: reads use the writer too, and wait their turn.
     */
    readonly memory: boolean,
  ) {
    this.writer = new WorkerConnection(url, authToken);
  }

  /**
   * Runs `take` once no transaction holds the writer. Writes queue here rather
   * than contend for SQLite's lock, whose busy handler polls in sleeps of up to
   * 100ms. `take` runs in the same synchronous step as the check, so two
   * waiters released together cannot both find the writer free. A transaction's
   * own body waiting here would wait for itself, so that fails at once — as it
   * did when the write met the lock on a second connection.
   */
  async whenWriterFree<T>(take: () => Promise<T>): Promise<T> {
    if (this.closed) throw new LibsqlError("The client is closed", "CLIENT_CLOSED");
    while (this.active) {
      if (transactionBodies.getStore() === this.active) {
        throw new Error(
          "A statement outside the open transaction cannot run inside its body: it would wait for that transaction to end",
        );
      }
      await this.active.ended;
    }
    return take();
  }

  /** Reads spread over reader threads, spawned as concurrent reads need them. */
  reader(): WorkerConnection {
    if (this.closed) throw new LibsqlError("The client is closed", "CLIENT_CLOSED");
    const idle = this.readers.find((connection) => connection.pending.size === 0);
    if (idle) return idle;
    if (this.readers.length < MAX_READERS) {
      const spawned = new WorkerConnection(this.url, this.authToken);
      this.readers.push(spawned);
      return spawned;
    }
    return this.readers.reduce((least, connection) =>
      connection.pending.size < least.pending.size ? connection : least,
    );
  }

  onWriter(request: Request): Promise<Result> {
    return this.whenWriterFree(() => this.writer.request(request));
  }

  execute(stmt: InStatement): Promise<ResultSet>;
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
  async execute(stmtOrSql: InStatement, args?: InArgs): Promise<ResultSet> {
    const stmt = toStatement(stmtOrSql, args);
    if (isRead(stmt) && !this.memory) {
      return single(await this.reader().request({ op: "execute", stmt }));
    }
    return single(await this.onWriter({ op: "execute", stmt }));
  }

  async batch(stmts: WireStatement[], mode?: TransactionMode): Promise<ResultSet[]> {
    return many(await this.onWriter({ op: "batch", stmts, mode }));
  }

  async migrate(stmts: InStatement[]): Promise<ResultSet[]> {
    return many(await this.onWriter({ op: "migrate", stmts }));
  }

  async executeMultiple(sql: string): Promise<void> {
    await this.onWriter({ op: "executeMultiple", sql });
  }

  transaction(mode?: TransactionMode): Promise<Transaction> {
    return this.whenWriterFree(async () => {
      // Taken before the BEGIN is sent, so every write issued from here on
      // waits for this transaction rather than landing inside it.
      const transaction = new WorkerTransaction(this.writer, () => {
        this.active = null;
      });
      this.active = transaction;
      try {
        await this.writer.request({ op: "transaction", mode });
      } catch (error) {
        transaction.end();
        throw error;
      }
      return transaction;
    });
  }

  /** Run a transaction's body marked as such, so a write that would wait for it fails instead. */
  runInTransactionBody<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.active) throw new Error("No transaction is open on this client");
    return transactionBodies.run(this.active, fn);
  }

  sync(): Promise<Replicated> {
    throw new Error("A local database has no replica to sync");
  }

  reconnect(): void {
    throw new Error("A local database worker cannot reconnect");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.close();
    for (const reader of this.readers) reader.close();
  }
}
