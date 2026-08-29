import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "#config";

export const DEFAULT_HOST = "http://localhost:8080";

/**
 * What `vektor login` persists; both fields stay overridable by env var. The host
 * is deliberately not stored — it comes from VEKTOR_HOST only.
 */
export interface StoredConfig {
  spaceId?: string;
  /** The browser login's token. An SSH login has none and removes this. */
  accessToken?: string;
  /** Fingerprint of the SSH key to sign with, chosen by `vektor login --ssh`. */
  sshKey?: string;
  /** Set instead of `sshKey` for a key file with no readable `.pub` beside it. */
  sshKeyPath?: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "vektor", "config.json");
}

export function readStoredConfig(): StoredConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as StoredConfig) : {};
  } catch {
    // Never logged in, or the file is unreadable: env vars and defaults still apply.
    return {};
  }
}

/** Merges into the existing file and returns the path written. */
export function writeStoredConfig(update: StoredConfig): string {
  const path = configPath();
  const next = { ...readStoredConfig(), ...update };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  chmodSync(path, 0o600);
  return path;
}

/** Returns the path removed, or undefined when there was nothing stored. */
export function clearStoredConfig(): string | undefined {
  const path = configPath();
  const existed = Object.keys(readStoredConfig()).length > 0;
  rmSync(path, { force: true });
  return existed ? path : undefined;
}

export function resolveHost(): string {
  return (config().CLI_HOST || DEFAULT_HOST).replace(/\/+$/, "");
}

/**
 * Record the key an SSH login chose, and drop the browser login's token with
 * it: the point of signing each request is that nothing standing is left on
 * disk, which a token from a previous login would quietly undo.
 *
 * @returns the path written.
 */
export function writeSshLogin(update: {
  spaceId?: string;
  fingerprint?: string;
  keyPath?: string;
}): string {
  const path = configPath();
  const { accessToken: _dropped, ...rest } = readStoredConfig();
  const next: StoredConfig = {
    ...rest,
    ...(update.spaceId ? { spaceId: update.spaceId } : {}),
    ...(update.fingerprint ? { sshKey: update.fingerprint } : {}),
    ...(update.keyPath ? { sshKeyPath: update.keyPath } : {}),
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
