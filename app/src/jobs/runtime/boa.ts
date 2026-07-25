/**
 * The Boa runtime: guest code runs in the native VM, one OS thread per run.
 *
 * The driver here is deliberately thin. It owns no execution logic — the VM
 * decides when to run and blocks when it has nothing to do — so all this does is
 * translate events into capability calls and back. There is no polling loop: the
 * previous workflow driver woke every 10 ms whether or not anything had
 * happened, which is exactly the cost this design removes.
 */

import { getNativeExec } from "#exec/native.ts";
import type { VmEvent } from "#native/exec/index.d.ts";
import { createCapabilities } from "./capabilities.ts";
import { PRELUDE } from "./prelude.ts";
import type { JobRunContext, JobRuntime } from "./types.ts";

export function createBoaRuntime(): JobRuntime {
  return {
    name: "boa",

    async execute(
      code: string,
      context: JobRunContext,
    ): Promise<Record<string, unknown>> {
      const { vmCreate, vmDestroy, vmReject, vmResolve } = await getNativeExec();

      /**
       * Where `output(...)` lands.
       *
       * There are two ways for code to produce its result, because there are two
       * kinds of code. A workflow script is authored inline and simply returns a
       * value. An extension job is a bundled ESM file, where a top-level `return`
       * is not valid source — those call `output(...)` instead, which maps
       * directly onto the `postMessage({ type: "result", ... })` they used to end
       * with. An explicit `output(...)` wins over the return value.
       */
      let declaredOutputs: Record<string, unknown> | undefined;

      const capabilities = createCapabilities({
        spaceId: context.spaceId,
        jobId: context.jobId,
        initiatedByUserId: context.initiatedByUserId,
        onLog: context.onLog,
        signal: context.signal,
        extra: {
          output: ((outputs: unknown) => {
            declaredOutputs =
              typeof outputs === "object" && outputs !== null && !Array.isArray(outputs)
                ? (outputs as Record<string, unknown>)
                : {};
            return null;
          }) as never,
          ...context.extraCapabilities,
        },
      });

      try {
        return await new Promise<Record<string, unknown>>((resolve, reject) => {
          let vmId: number | null = null;
          let settled = false;

          const finish = (outcome: () => void) => {
            if (settled) return;
            settled = true;
            context.signal?.removeEventListener("abort", onAbort);
            outcome();
          };

          const onAbort = () => {
            // The VM rejects in-flight calls and lets the script unwind, so the
            // terminal error event still arrives and settles this promise.
            if (vmId !== null) vmDestroy(vmId);
          };

          const onEvent = (event: VmEvent) => {
            switch (event.type) {
              case "log":
                context.onLog(event.message ?? "");
                return;

              case "call": {
                const { callId, name } = event;
                if (!callId || !name) return;
                const capability = capabilities.table[name];
                if (!capability) {
                  // Deny by default: a capability the host did not grant.
                  if (vmId !== null) {
                    vmReject(vmId, callId, `"${name}" is not available in this job`);
                  }
                  return;
                }
                // Capabilities may be sync or async; normalize to a promise so a
                // synchronous throw becomes a rejection in the guest too.
                void (async () => {
                  try {
                    const args = (event.args ?? []) as never[];
                    const value = await capability(...args);
                    if (vmId !== null) vmResolve(vmId, callId, value ?? null);
                  } catch (error) {
                    const message =
                      error instanceof Error ? error.message : String(error);
                    if (vmId !== null) vmReject(vmId, callId, message);
                  }
                })();
                return;
              }

              case "done": {
                const returned = event.output;
                const fromReturn =
                  typeof returned === "object" &&
                  returned !== null &&
                  !Array.isArray(returned)
                    ? (returned as Record<string, unknown>)
                    : {};
                finish(() => resolve(declaredOutputs ?? fromReturn));
                return;
              }

              case "error":
                finish(() => reject(new Error(event.message ?? "job failed")));
                return;
            }
          };

          try {
            vmId = vmCreate(
              PRELUDE,
              code,
              context.inputs,
              { timeoutMs: context.timeoutMs },
              onEvent,
            );
          } catch (error) {
            finish(() =>
              reject(error instanceof Error ? error : new Error(String(error))),
            );
            return;
          }

          // An abort that arrives before the VM is created still has to land.
          if (context.signal?.aborted) onAbort();
          else context.signal?.addEventListener("abort", onAbort, { once: true });
        });
      } finally {
        await capabilities.dispose();
      }
    },
  };
}
