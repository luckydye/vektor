import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { jobRunner } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";

export type JobRunner = {
  id: string;
  name: string;
  url: string;
  createdBy: string;
  createdAt: Date;
};

const columns = {
  id: jobRunner.id,
  name: jobRunner.name,
  url: jobRunner.url,
  createdBy: jobRunner.createdBy,
  createdAt: jobRunner.createdAt,
};

export async function listJobRunners(s: SpaceStore): Promise<JobRunner[]> {
  const rows = await s.db.select(columns).from(jobRunner);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** The runners with the secret the server sends them, for running jobs. */
export async function listJobRunnersWithSecrets(
  s: SpaceStore,
): Promise<Array<JobRunner & { secret: string }>> {
  const rows = await s.db.select().from(jobRunner);
  return rows.map(({ ciphertext, iv, authTag, ...runner }) => ({
    ...runner,
    secret: decryptSecret({ ciphertext, iv, authTag }),
  }));
}

/** Registers a runner; its secret is returned only here. */
export async function createJobRunner(
  s: SpaceStore,
  input: { name: string; url: string; createdBy: string },
): Promise<{ runner: JobRunner; secret: string }> {
  const secret = randomBytes(32).toString("base64url");
  const runner: JobRunner = {
    id: createId("runner"),
    name: input.name,
    url: input.url,
    createdBy: input.createdBy,
    createdAt: new Date(),
  };
  await s.db.insert(jobRunner).values({ ...runner, ...encryptSecret(secret) });
  return { runner, secret };
}

export async function deleteJobRunner(s: SpaceStore, id: string): Promise<boolean> {
  const deleted = await s.db
    .delete(jobRunner)
    .where(eq(jobRunner.id, id))
    .returning({ id: jobRunner.id });
  return deleted.length > 0;
}
