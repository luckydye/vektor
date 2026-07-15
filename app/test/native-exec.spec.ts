import { describe, expect, it } from "bun:test";
import { getNativeExec } from "#exec/native.ts";

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

  it("steps a workflow across a native runJob promise", async () => {
    const native = await getNativeExec();
    const id = native.workflowVmCreate(
      'log(input.name); const job = await runJob("ext", "job", { count: 2 }); return { answer: job.value + 1 };',
      { name: "start" },
    );

    try {
      expect(native.workflowVmStep(id)).toMatchObject({ type: "log", message: "start" });
      const pending = native.workflowVmStep(id);
      expect(pending).toMatchObject({
        type: "pending_job",
        extensionId: "ext",
        workflowJobId: "job",
        inputs: { count: 2 },
      });
      if (!pending.jobId) throw new Error("native runtime omitted the pending job ID");
      native.workflowVmResolveJob(id, pending.jobId, { value: 41 });
      expect(native.workflowVmStep(id)).toEqual({ type: "done", output: { answer: 42 } });
    } finally {
      native.workflowVmDestroy(id);
    }
  });
});
