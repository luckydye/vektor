import { IndexedDBStore } from "./storage.ts";

export interface HistoryEntry {
  url: string;
  title: string;
  lastVisited: number;
  visitCount: number;
}

export class History {
  private store: IndexedDBStore<HistoryEntry>;

  constructor(storeName: string) {
    const scopedName = `history_v1_${storeName}`;

    this.store = new IndexedDBStore<HistoryEntry>({
      dbName: "history",
      storeName: scopedName,
      keyPath: "url",
      indexes: [
        { name: "lastVisited", keyPath: "lastVisited", unique: false },
        { name: "visitCount", keyPath: "visitCount", unique: false },
      ],
    });
  }

  /**
   * Log a page visit, updating existing entry if it exists
   */
  async log(url: string, title: string): Promise<void> {
    const existing = await this.store.get(url);

    const entry: HistoryEntry = {
      url,
      title,
      lastVisited: Date.now(),
      visitCount: existing ? existing.visitCount + 1 : 1,
    };

    await this.store.put(entry);
  }

  /**
   * Get recent pages sorted by last visited time
   */
  async getRecent(limit = 50): Promise<HistoryEntry[]> {
    const results = await this.store.getByIndex("lastVisited", undefined, "prev", limit);
    return results;
  }

  /**
   * Get all history entries sorted by recency
   */
  async getAll(): Promise<HistoryEntry[]> {
    const results = await this.store.getByIndex("lastVisited", undefined, "prev");
    return results;
  }

  /**
   * Get a specific history entry by URL
   */
  async get(url: string): Promise<HistoryEntry | null> {
    return this.store.get(url);
  }

  /**
   * Clear a specific entry from history
   */
  async remove(url: string): Promise<void> {
    return this.store.delete(url);
  }

  /**
   * Clear all history entries
   */
  async clear(): Promise<void> {
    return this.store.clear();
  }

  /**
   * Search history entries by title or URL
   */
  async search(query: string): Promise<HistoryEntry[]> {
    const all = await this.getAll();
    const lowerQuery = query.toLowerCase();

    return all.filter(
      (entry) =>
        entry.title.toLowerCase().includes(lowerQuery) ||
        entry.url.toLowerCase().includes(lowerQuery),
    );
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.store.close();
  }
}

/**
 * Singleton instance for convenience
 */
export const history = new History(location.pathname.split("/")[1]);
