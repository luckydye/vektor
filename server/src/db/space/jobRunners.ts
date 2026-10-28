import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { jobRunner } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";
import { JOBS_ONLY, type RunnerDescription } from "#runners/contract.ts";

export type JobRunner = {
  id: string;
  name: string;
  url: string;
  description: RunnerDescription;
  createdBy: string;
  createdAt: Date;
};

type Row = typeof jobRunner.$inferSelect;

const toRunner = ({ ciphertext, iv, authTag, description, ...row }: Row): JobRunner => ({
  ...row,
  description: JSON.parse(description) as RunnerDescription,
});

export async function listJobRunners(s: SpaceStore): Promise<JobRunner[]> {
  const rows = await s.db.select().from(jobRunner);
  return rows.map(toRunner).sort((a, b) => a.name.localeCompare(b.name));
}

/** The runners with the secret the server sends them, for handing them runs. */
export async function listJobRunnersWithSecrets(
  s: SpaceStore,
): Promise<Array<JobRunner & { secret: string }>> {
  const rows = await s.db.select().from(jobRunner);
  return rows.map((row) => ({ ...toRunner(row), secret: decryptSecret(row) }));
}

/**
 * Registers a runner; its secret is returned only here. It runs jobs only
 * until it is described, which it can answer once it holds the secret.
 */
export async function createJobRunner(
  s: SpaceStore,
  input: { name: string; url: string; createdBy: string },
): Promise<{ runner: JobRunner; secret: string }> {
  const secret = randomBytes(32).toString("base64url");
  const runner: JobRunner = {
    id: createId("runner"),
    createdAt: new Date(),
    description: JOBS_ONLY,
    ...input,
  };
  await s.db.insert(jobRunner).values({
    ...runner,
    description: JSON.stringify(runner.description),
    ...encryptSecret(secret),
  });
  return { runner, secret };
}

export async function setJobRunnerDescription(
  s: SpaceStore,
  id: string,
  description: RunnerDescription,
): Promise<void> {
  await s.db
    .update(jobRunner)
    .set({ description: JSON.stringify(description) })
    .where(eq(jobRunner.id, id));
}

export async function deleteJobRunner(s: SpaceStore, id: string): Promise<boolean> {
  const deleted = await s.db
    .delete(jobRunner)
    .where(eq(jobRunner.id, id))
    .returning({ id: jobRunner.id });
  return deleted.length > 0;
}
