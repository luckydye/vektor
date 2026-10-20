/**
 * Marks the async context of a database transaction, so external I/O can refuse
 * to run there: on Durable Objects an await inside a transaction blocks the
 * whole space until it settles.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const transactions = new AsyncLocalStorage<{ open: boolean }>();

/**
 * Run `fn` as a transaction's body. The mark is cleared when it settles, so a
 * timer or promise it left behind runs as outside the transaction.
 */
export function withinTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const mark = { open: true };
  return transactions.run(mark, fn).finally(() => {
    mark.open = false;
  });
}

/** Throw when called from inside a transaction's body, naming `operation`. */
export function assertOutsideTransaction(operation: string): void {
  if (transactions.getStore()?.open) {
    throw new Error(
      `${operation} cannot run inside a database transaction; do it before the transaction or after it commits`,
    );
  }
}
