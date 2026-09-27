/**
 * The S3 adapter against a real S3-compatible server, so the parts that only
 * exist over the wire — ranged GETs, paginated listings, a HEAD that 404s —
 * are exercised rather than mocked.
 *
 * Needs a server; `task s3:up` starts RustFS and creates the bucket. Without
 * VEKTOR_TEST_S3_ENDPOINT the suite skips rather than failing, so the default
 * `task test` run does not depend on a container.
 *
 * Run with:
 *   task s3:up && task test -- test/s3-storage.spec.ts
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3FileStorage } from "#files/s3Storage.ts";
import type { FileStorageAdapter } from "#files/storage.ts";
import { describeFileStorageContract } from "./helpers/fileStorageContract.ts";

const endpoint = process.env.VEKTOR_TEST_S3_ENDPOINT;

let storage: FileStorageAdapter;
let stagingDir: string;
// Every run gets its own prefix: the bucket outlives the suite, and a listing
// assertion that saw a previous run's objects would fail for the wrong reason.
const prefix = `test-${randomUUID()}`;
const SPACE = "space_1";

describe.skipIf(!endpoint)("s3 adapter", () => {
  beforeAll(() => {
    stagingDir = mkdtempSync(join(tmpdir(), "vektor-s3-staging-"));
    storage = createS3FileStorage({
      bucket: process.env.VEKTOR_TEST_S3_BUCKET ?? "vektor-test",
      endpoint,
      region: process.env.VEKTOR_TEST_S3_REGION ?? "us-east-1",
      accessKeyId: process.env.VEKTOR_TEST_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.VEKTOR_TEST_S3_SECRET_ACCESS_KEY,
      prefix,
      stagingDir,
    });
  });

  afterAll(() => {
    rmSync(stagingDir, { recursive: true, force: true });
  });

  describeFileStorageContract("contract", () => ({
    storage,
    space: SPACE,
    neighbour: "space_2",
  }));

  describe("object storage specifics", () => {
    it("keeps the serving URL identical to the local adapter", () => {
      // The `file` table stores these, so a deployment that switches backends
      // must not invalidate every URL it has already handed out.
      expect(storage.url(SPACE, "ab/file.bin")).toBe(
        "/api/v1/spaces/space_1/uploads/ab/file.bin",
      );
    });

    it("stages a hashed upload without leaving the staging file behind", async () => {
      const body = new Response(Buffer.from("staged")).body;
      const stored = await storage.putHashed(
        SPACE,
        "bin",
        body as ReadableStream<Uint8Array>,
      );
      expect(await storage.read(SPACE, stored.key)).toEqual(Buffer.from("staged"));
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(stagingDir)).toEqual([]);
    });
  });
});
