/**
 * Processed image outputs, one job per shape and resolution tier. A job starts
 * only when its parameters change, and the newest request wins.
 */
import { sameOriginMediaUrl } from "#canvas/render/imageSource.ts";
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
    const processors = options.plugins.processorsFor(shape);
    const key = `${shape.id}|${sourceUrl}`;
    if (processors.length === 0) {
      const stale = jobs.get(key);
      if (stale) drop(key, stale);
      return null;
    }
    const steps = processors.map((processor) => ({
      processor,
      params: shape.data[pluginDataKey(processor.owner)],
    }));
    const paramsKey = JSON.stringify(steps.map(({ processor, params }) => [processor.id, params]));
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
    const { signal } = controller;
    const show = (output: TexImageSource) => {
      if (current.output) releaseTexture(current.output);
      current.output = output;
      invalidate();
    };

    // Each step works on the previous one's pixels. Only the last step's
    // progress is shown: an earlier one's is not the finished chain.
    const run = async () => {
      const response = await fetch(sameOriginMediaUrl(sourceUrl), { signal });
      if (!response.ok) throw new Error(`Loading the image failed: ${response.status}`);
      let source = await createImageBitmap(await response.blob());
      let sourceKey = sourceUrl;
      let output: TexImageSource = source;
      for (const [index, { processor, params }] of steps.entries()) {
        const last = index === steps.length - 1;
        output = await processor.process({
          shape,
          params,
          source,
          sourceKey,
          signal,
          progress: (image) => {
            if (last && !signal.aborted) show(image);
          },
        });
        signal.throwIfAborted();
        if (!last) {
          source = await createImageBitmap(output);
          sourceKey = `${sourceKey}|${processor.id}:${JSON.stringify(params)}`;
        }
      }
      return output;
    };
    run().then(
      (output) => {
        if (signal.aborted) return;
        current.inflight = null;
        show(output);
      },
      (error) => {
        if (signal.aborted) return;
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
