import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { spaceRunner } from "#db/schema/space.ts";
import { decryptSecret, encryptSecret } from "#db/secretsCrypto.ts";
import { NO_AGENTS, type RunnerDescription } from "#runners/contract.ts";

export type SpaceRunner = {
  id: string;
  name: string;
  url: string;
  description: RunnerDescription;
  createdBy: string;
  createdAt: Date;
};

type Row = typeof spaceRunner.$inferSelect;

const toRunner = ({
  ciphertext,
  iv,
  authTag,
  description,
  ...row
}: Row): SpaceRunner => ({
  ...row,
  description: JSON.parse(description) as RunnerDescription,
});

export async function listSpaceRunners(s: SpaceStore): Promise<SpaceRunner[]> {
  const rows = await s.db.select().from(spaceRunner);
  return rows.map(toRunner).sort((a, b) => a.name.localeCompare(b.name));
}

/** The runners with the secret the server sends them, for handing them runs. */
export async function listSpaceRunnersWithSecrets(
  s: SpaceStore,
): Promise<Array<SpaceRunner & { secret: string }>> {
  const rows = await s.db.select().from(spaceRunner);
  return rows.map((row) => ({ ...toRunner(row), secret: decryptSecret(row) }));
}

/**
 * Registers a runner; its secret is returned only here. It runs jobs only
 * until it is described, which it can answer once it holds the secret.
 */
export async function createSpaceRunner(
  s: SpaceStore,
  input: { name: string; url: string; createdBy: string },
): Promise<{ runner: SpaceRunner; secret: string }> {
  const secret = randomBytes(32).toString("base64url");
  const runner: SpaceRunner = {
    id: createId("runner"),
    createdAt: new Date(),
    description: NO_AGENTS,
    ...input,
  };
  await s.db.insert(spaceRunner).values({
    ...runner,
    description: JSON.stringify(runner.description),
    ...encryptSecret(secret),
  });
  return { runner, secret };
}

export async function setSpaceRunnerDescription(
  s: SpaceStore,
  id: string,
  description: RunnerDescription,
): Promise<void> {
  await s.db
    .update(spaceRunner)
    .set({ description: JSON.stringify(description) })
    .where(eq(spaceRunner.id, id));
}

export async function deleteSpaceRunner(s: SpaceStore, id: string): Promise<boolean> {
  const deleted = await s.db
    .delete(spaceRunner)
    .where(eq(spaceRunner.id, id))
    .returning({ id: spaceRunner.id });
  return deleted.length > 0;
}
