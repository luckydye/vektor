/**
 * Processed image outputs, one job per shape and resolution tier. A job starts
 * only when its parameters change, and the newest request wins.
 */
import { releaseTexture } from "#canvas/render/webgl.ts";
import type { CanvasShape } from "#canvas/runtime/extensionApi.ts";
import { type CanvasPlugins, pluginDataKey } from "#canvas/runtime/plugins.ts";

type Job = {
  shapeId: string;
  paramsKey: string;
  output: TexImageSource | null;
  inflight: AbortController | null;
};

export function createImageProcessing(options: {
  plugins: CanvasPlugins;
  reportError: (error: unknown) => void;
}) {
  const jobs = new Map<string, Job>();

  function drop(key: string, job: Job) {
    job.inflight?.abort();
    if (job.output) releaseTexture(job.output);
    jobs.delete(key);
  }

  /**
   * The processed pixels for `sourceUrl`, or null when no processor applies or
   * none have arrived yet. Stale output keeps painting while a new job runs.
   */
  function processed(
    shape: CanvasShape,
    sourceUrl: string,
    invalidate: () => void,
  ): TexImageSource | null {
    const processor = options.plugins.processorFor(shape);
    const key = `${shape.id}|${sourceUrl}`;
    if (!processor) {
      const stale = jobs.get(key);
      if (stale) drop(key, stale);
      return null;
    }
    const params = shape.data[pluginDataKey(processor.owner)];
    const paramsKey = `${processor.id}|${JSON.stringify(params)}`;
    let job = jobs.get(key);
    if (!job) {
      job = { shapeId: shape.id, paramsKey: "", output: null, inflight: null };
      jobs.set(key, job);
    }
    // A failed key keeps its paramsKey, so it is not retried until the data changes.
    if (job.paramsKey === paramsKey) return job.output;

    const current = job;
    current.paramsKey = paramsKey;
    current.inflight?.abort();
    const controller = new AbortController();
    current.inflight = controller;
    processor.process({ shape, params, sourceUrl, signal: controller.signal }).then(
      (output) => {
        if (controller.signal.aborted) return;
        current.inflight = null;
        if (current.output) releaseTexture(current.output);
        current.output = output;
        invalidate();
      },
      (error) => {
        if (controller.signal.aborted) return;
        current.inflight = null;
        options.reportError(error);
      },
    );
    return current.output;
  }

  return {
    processed,
    /** Jobs still running, so an export can wait for them. */
    pending: () => [...jobs.values()].filter((job) => job.inflight).length,
    /** Drops jobs for shapes that no longer exist. */
    retain(exists: (shapeId: string) => boolean) {
      for (const [key, job] of jobs) if (!exists(job.shapeId)) drop(key, job);
    },
    clear() {
      for (const [key, job] of jobs) drop(key, job);
    },
  };
}

export type CanvasImageProcessing = ReturnType<typeof createImageProcessing>;
