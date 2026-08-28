import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A fresh data directory for the run, so no spec reads the accounts and spaces
 * a developer accumulated in `app/data`.
 *
 * One directory for the whole run rather than one per spec: the server project
 * runs `isolate: false`, so every file shares `globalThis.__vektor_auth_db` and
 * only the first connection's path takes effect. Set here rather than in a
 * setup file because global setup runs before any worker starts, which is the
 * last moment the value can still reach a spec that opens the database on
 * import.
 */
export default function setup() {
  if (process.env.VEKTOR_DATA_DIR) return;

  const directory = mkdtempSync(path.join(tmpdir(), "vektor-test-"));
  process.env.VEKTOR_DATA_DIR = directory;

  return () => {
    rmSync(directory, { recursive: true, force: true });
  };
}
