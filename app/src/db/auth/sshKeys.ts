/**
 * The SSH public keys a user can log the CLI in with.
 *
 * A key is a credential the user registers once and then proves possession of
 * per login, so nothing secret lives here: only the public half, the
 * fingerprint a login is looked up by, and when it was last used — which is what
 * makes an unused or unexpected key visible enough to remove.
 */

import { and, desc, eq } from "drizzle-orm";
import { getAuthDb } from "#db/client/db.ts";
import { many, one } from "#db/client/query.ts";
import { createId } from "#db/ids.ts";
import { userSshKey } from "#db/schema/auth.ts";
import { parseSshPublicKey } from "#utils/sshKeys.ts";

export interface UserSshKey {
  id: string;
  name: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** A key registered to somebody else already answers for them; two owners is not a state. */
export class SshKeyInUseError extends Error {
  constructor() {
    super("This SSH key is already registered");
  }
}

const MAX_KEY_NAME_LENGTH = 100;

export async function listUserSshKeys(userId: string): Promise<UserSshKey[]> {
  return await many(
    getAuthDb()
      .select({
        id: userSshKey.id,
        name: userSshKey.name,
        keyType: userSshKey.keyType,
        publicKey: userSshKey.publicKey,
        fingerprint: userSshKey.fingerprint,
        createdAt: userSshKey.createdAt,
        lastUsedAt: userSshKey.lastUsedAt,
      })
      .from(userSshKey)
      .where(eq(userSshKey.userId, userId))
      .orderBy(desc(userSshKey.createdAt)),
  );
}

/**
 * Register an `authorized_keys` line for a user.
 *
 * @param name what the key is called in the listing; falls back to the line's
 *   own comment, then to the key type, so a paste with neither still reads.
 * @throws {SshKeyError} the line is not a supported public key
 * @throws {SshKeyInUseError} the key is registered — to this user or another one
 */
export async function addUserSshKey(
  userId: string,
  line: string,
  name?: string,
): Promise<UserSshKey> {
  const parsed = parseSshPublicKey(line);

  if (await findSshKeyByFingerprint(parsed.fingerprint)) {
    throw new SshKeyInUseError();
  }

  const row = {
    id: createId("sshKey"),
    userId,
    name: (name?.trim() || parsed.comment.trim() || parsed.type).slice(
      0,
      MAX_KEY_NAME_LENGTH,
    ),
    keyType: parsed.type,
    publicKey: parsed.publicKey,
    fingerprint: parsed.fingerprint,
    createdAt: new Date(),
    lastUsedAt: null,
  };

  await getAuthDb().insert(userSshKey).values(row);

  const { userId: _owner, ...key } = row;
  return key;
}

/** Scoped to the owner, so an id guessed from elsewhere deletes nothing. */
export async function deleteUserSshKey(userId: string, keyId: string): Promise<boolean> {
  const existing = await one(
    getAuthDb()
      .select({ id: userSshKey.id })
      .from(userSshKey)
      .where(and(eq(userSshKey.id, keyId), eq(userSshKey.userId, userId))),
  );
  if (!existing) return false;

  await getAuthDb().delete(userSshKey).where(eq(userSshKey.id, keyId));
  return true;
}

/** The account a signature's key belongs to, or undefined when nobody registered it. */
export async function findSshKeyByFingerprint(
  fingerprint: string,
): Promise<{ id: string; userId: string; name: string } | undefined> {
  return await one(
    getAuthDb()
      .select({ id: userSshKey.id, userId: userSshKey.userId, name: userSshKey.name })
      .from(userSshKey)
      .where(eq(userSshKey.fingerprint, fingerprint)),
  );
}

/** Records a successful login. Best effort: a failed write must not fail the login. */
export async function markSshKeyUsed(keyId: string): Promise<void> {
  await getAuthDb()
    .update(userSshKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(userSshKey.id, keyId));
}
