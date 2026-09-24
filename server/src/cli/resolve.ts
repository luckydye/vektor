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
  accessToken?: string;
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

function resolveToken(): string | undefined {
  return config().CLI_ACCESS_TOKEN || readStoredConfig().accessToken;
}

async function resolveSpaceId(host: string, token?: string): Promise<string> {
  const configured = config().CLI_SPACE_ID || readStoredConfig().spaceId;
  if (configured) return configured;

  const res = await fetch(`${host}/api/v1/spaces`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`Failed to discover spaces from ${host} (${res.status})`);
  const spaces = (await res.json()) as Array<{ id: string }>;
  if (!spaces.length) throw new Error("No spaces found on server");
  return spaces[0].id;
}

/**
 * Everything a command needs to reach the API. Discovering the space may cost a
 * request, so call this once per command rather than per API call.
 */
export async function resolveConfig(): Promise<{
  host: string;
  token: string | undefined;
  spaceId: string;
}> {
  const host = resolveHost();
  const token = resolveToken();
  return { host, token, spaceId: await resolveSpaceId(host, token) };
}
