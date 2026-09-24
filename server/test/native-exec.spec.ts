import { describe, expect, it } from "vitest";
import { getNativeExec } from "#exec/native.ts";
import { PRELUDE } from "#jobs/runtime/prelude.ts";

describe("native JavaScript runtime", () => {
  it("evaluates js-exec code with process globals", async () => {
    const result = (await getNativeExec()).evalJsSync(
      "console.log(process.argv[2], process.env.KEY); console.error(process.cwd())",
      {
        argv: ["js-exec", "script.js", "argument"],
        cwd: "/workspace",
        env: [["KEY", "value"]],
        platform: "test",
        version: "test",
      },
    );

    expect(result).toEqual({
      stdout: "argument value\n",
      stderr: "/workspace\n",
      exitCode: 0,
    });
  });

  it("drains promises used by module-mode top-level await", async () => {
    const result = (await getNativeExec()).evalJsSync(
      "(async () => { await Promise.resolve(); console.log('after await'); })()",
      {
        argv: ["js-exec", "module.js"],
        cwd: "/workspace",
        env: [],
        platform: "test",
        version: "test",
      },
    );

    expect(result).toMatchObject({ stdout: "after await\n", exitCode: 0 });
  });

  it("runs a script on its own thread, answering host calls", async () => {
    const native = await getNativeExec();

    const events: string[] = [];
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let id = 0;
      id = native.vmCreate(
        "",
        "__log(input.name); const job = await __hostCall('runJob', 'ext', 'job', { count: 2 }); return { answer: job.value + 1 };",
        { name: "start" },
        { timeoutMs: 5000 },
        (event) => {
          if (event.type === "log") {
            events.push(`log:${event.message}`);
          } else if (event.type === "call") {
            events.push(`call:${event.name}:${JSON.stringify(event.args)}`);
            native.vmResolve(id, event.callId ?? "", { value: 41 });
          } else if (event.type === "done") {
            resolve((event.output ?? {}) as Record<string, unknown>);
          } else if (event.type === "error") {
            reject(new Error(event.message));
          }
        },
      );
    });

    expect(events).toEqual(["log:start", 'call:runJob:["ext","job",{"count":2}]']);
    expect(result).toEqual({ answer: 42 });
  });

  it("keeps the main thread responsive while a script burns CPU", async () => {
    const native = await getNativeExec();

    // A tick counter can only advance if the event loop is not blocked, which is
    // the whole point of running the VM on its own thread.
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 5);

    try {
      await new Promise<void>((resolve, reject) => {
        native.vmCreate(
          "",
          "let x = 0; for (let i = 0; i < 4_000_000; i++) x += i; return { x };",
          {},
          { timeoutMs: 30_000 },
          (event) => {
            if (event.type === "done") resolve();
            else if (event.type === "error") reject(new Error(event.message));
          },
        );
      });
    } finally {
      clearInterval(timer);
    }

    expect(ticks).toBeGreaterThan(0);
  });

  it("reports a script error instead of hanging on an unanswered await", async () => {
    const native = await getNativeExec();

    const message = await new Promise<string>((resolve, reject) => {
      native.vmCreate(
        "",
        "await new Promise(() => {}); return {};",
        {},
        { timeoutMs: 5000 },
        (event) => {
          if (event.type === "error") resolve(event.message ?? "");
          else if (event.type === "done") reject(new Error("expected an error"));
        },
      );
    });

    expect(message).toContain("never resolves");
  });

  it("exposes the whole documented global surface to guest code", async () => {
    const native = await getNativeExec();

    // Every global a job is documented to have. A capability accidentally
    // dropped from the prelude, or a platform primitive missing from the engine,
    // fails here rather than at the first job that happens to use it.
    const expected = [
      // Platform primitives, provided by the engine (platform.rs).
      "URL",
      "URLSearchParams",
      "crypto",
      "structuredClone",
      "TextEncoder",
      "TextDecoder",
      "btoa",
      "atob",
      // Capabilities, provided by the prelude over __hostCall.
      "log",
      "console",
      "output",
      "fetch",
      "apiFetch",
      "agentPrompt",
      "hash",
      "sleep",
      "setTimeout",
      "clearTimeout",
      "Headers",
      "readDocument",
      "writeDocument",
      "createDocument",
      "searchDocuments",
      "uploadArtifact",
      "getSecret",
      "runJob",
      "jobCache",
      "zip",
      "spreadsheet",
      "scratch",
      "exec",
      "process",
    ];

    const missing = await new Promise<string[]>((resolve, reject) => {
      native.vmCreate(
        PRELUDE,
        `const names = ${JSON.stringify(expected)};
         return { missing: names.filter((name) => typeof globalThis[name] === "undefined") };`,
        {},
        { timeoutMs: 10_000 },
        (event) => {
          if (event.type === "done") {
            resolve((event.output as { missing: string[] }).missing);
          } else if (event.type === "error") {
            reject(new Error(event.message));
          }
        },
      );
    });

    expect(missing).toEqual([]);
  });
});
