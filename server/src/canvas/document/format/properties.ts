/**
 * Timestamps and the per-key merge: for each key, the write with the highest
 * `(counter, writer)` wins. Writes apply in any order and any number of times.
 */

import type { PropertyGroup, PropertyValue } from "#canvas/document/format/records.ts";

export interface Timestamp {
  counter: number;
  /** 16 hex digits of a u64, so string order is numeric order. */
  writer: string;
}

export interface PropertyEntry extends Timestamp {
  value: PropertyValue;
}

/** Winning value and timestamp per key. A `null` value is a removed key that still wins. */
export type PropertyState = Map<string, PropertyEntry>;

/** Writer 0 is reserved for migration. */
export const MIGRATION_WRITER = "0000000000000000";

export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.writer < b.writer ? -1 : a.writer > b.writer ? 1 : 0;
}

export function randomWriterId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return id === MIGRATION_WRITER ? randomWriterId() : id;
}

/** Applies one write; returns whether it won. */
export function applyWrite(
  state: PropertyState,
  key: string,
  value: PropertyValue,
  timestamp: Timestamp,
): boolean {
  const current = state.get(key);
  if (current && compareTimestamps(current, timestamp) >= 0) return false;
  state.set(key, { value, counter: timestamp.counter, writer: timestamp.writer });
  return true;
}

/** Applies every write of `groups`; returns the keys whose winning value changed. */
export function applyGroups(
  state: PropertyState,
  groups: readonly PropertyGroup[],
): string[] {
  const changed: string[] = [];
  for (const group of groups) {
    for (const [key, value] of group.entries) {
      if (applyWrite(state, key, value, group)) changed.push(key);
    }
  }
  return changed;
}

/** The winning values, one group per distinct timestamp, as a base stores them. */
export function stateToGroups(state: PropertyState): PropertyGroup[] {
  const byTimestamp = new Map<string, PropertyGroup>();
  for (const [key, entry] of state) {
    const stamp = `${entry.counter}:${entry.writer}`;
    let group = byTimestamp.get(stamp);
    if (!group) {
      group = { counter: entry.counter, writer: entry.writer, entries: [] };
      byTimestamp.set(stamp, group);
    }
    group.entries.push([key, entry.value]);
  }
  return [...byTimestamp.values()].sort(compareTimestamps);
}

/** Whether two property values are equal; byte values compare by content. */
export function sameValue(
  a: PropertyValue | undefined,
  b: PropertyValue | undefined,
): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    );
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The highest counter in `state`, 0 for none. */
export function maxCounter(state: PropertyState): number {
  let max = 0;
  for (const entry of state.values()) max = Math.max(max, entry.counter);
  return max;
}

/** The live value of `key`, undefined when absent or removed. */
export function readProperty(
  state: PropertyState,
  key: string,
): PropertyValue | undefined {
  const value = state.get(key)?.value;
  return value === null ? undefined : value;
}

/**
 * A session's Lamport clock: one counter for all objects, which only grows. A
 * write takes `max(session counter, highest counter in the object) + 1`.
 */
export interface Clock {
  readonly writer: string;
  counter: number;
  next(state: PropertyState): Timestamp;
}

export function createClock(writer: string = randomWriterId()): Clock {
  return {
    writer,
    counter: 0,
    next(state) {
      this.counter = Math.max(this.counter, maxCounter(state)) + 1;
      return { counter: this.counter, writer: this.writer };
    },
  };
}
