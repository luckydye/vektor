import { describe, expect, it } from "bun:test";
import type { Bash } from "just-bash";
import { createAgentShell, runAgentPrompt } from "#agent/core.ts";
import type { ChatMessage } from "#provider/types.ts";

const provider = {
  provider: "ollama" as const,
  baseUrl: "http://unused.invalid",
  model: "test",
};

describe("agent model loop", () => {
  it("retries an empty completion and executes the subsequent tool call", async () => {
    const responses: Array<{ message: ChatMessage; finishReason: string }> = [
      { message: { role: "assistant", content: null }, finishReason: "stop" },
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: "js-exec -c 'console.log(2 + 2)'" }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "JavaScript returned 4." },
        finishReason: "stop",
      },
    ];
    const commands: string[] = [];
    const events: string[] = [];
    const bash = {
      exec: async (command: string) => {
        commands.push(command);
        return { stdout: "4\n", stderr: "", exitCode: 0 };
      },
    } as unknown as Bash;

    const result = await runAgentPrompt({
      messages: [{ role: "user", content: "Run JavaScript" }],
      apiUrl: "http://unused.invalid",
      spaceId: "space",
      jobToken: "token",
      provider,
      bash,
      modelCaller: async (options) => {
        const response = responses.shift();
        if (!response) throw new Error("No mock model response remaining");
        if (response.message.content) {
          await options.onText?.(response.message.content);
        }
        return response;
      },
      onEvent: (event) => events.push(event.type),
    });

    expect(commands).toEqual(["js-exec -c 'console.log(2 + 2)'"]);
    expect(events).toEqual(["status", "tool_call", "tool_result", "text"]);
    expect(result.content).toBe("JavaScript returned 4.");
  });

  it("fails visibly after repeated empty completions", async () => {
    const bash = {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    } as unknown as Bash;

    await expect(
      runAgentPrompt({
        messages: [{ role: "user", content: "Run JavaScript" }],
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        jobToken: "token",
        provider,
        bash,
        modelCaller: async () => ({
          message: { role: "assistant", content: null },
          finishReason: "stop",
        }),
      }),
    ).rejects.toThrow("empty response 3 times");
  });

  it("reads, overwrites, and appends files without shell commands", async () => {
    const bash = createAgentShell({
      current: {
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        jobToken: "token",
      },
    });
    const initialContent = 'ablausd "aslnads"\n$HOME `oops`\n';
    const responses: Array<{ message: ChatMessage; finishReason: string }> = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "./asd.txt",
                  content: initialContent,
                }),
              },
            },
            {
              id: "write-2",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({
                  path: "./asd.txt",
                  content: "emoji: 🧪\n",
                  mode: "append",
                }),
              },
            },
            {
              id: "read-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "./asd.txt" }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "Done." },
        finishReason: "stop",
      },
    ];
    let callCount = 0;

    await runAgentPrompt({
      messages: [{ role: "user", content: "Write the file" }],
      apiUrl: "http://unused.invalid",
      spaceId: "space",
      jobToken: "token",
      provider,
      bash,
      modelCaller: async (options) => {
        if (callCount === 0) {
          const toolNames = (options.tools as Array<{ function: { name: string } }>).map(
            (tool) => tool.function.name,
          );
          expect(toolNames.slice(0, 4)).toEqual([
            "bash",
            "list_files",
            "read_file",
            "write_file",
          ]);
          expect(toolNames).toContain("list_documents");
          expect(toolNames).toContain("edit_document");
        } else {
          const toolResults = options.messages.filter(
            (message) => message.role === "tool",
          );
          expect(toolResults.at(-1)?.content).toBe(`${initialContent}emoji: 🧪\n`);
        }
        callCount += 1;
        const response = responses.shift();
        if (!response) throw new Error("No mock model response remaining");
        if (response.message.content) {
          await options.onText?.(response.message.content);
        }
        return response;
      },
    });

    const filePath = bash.fs.resolvePath(bash.getCwd(), "./asd.txt");
    expect(await bash.fs.readFile(filePath, "utf8")).toBe(`${initialContent}emoji: 🧪\n`);
  });

  it("lists a directory and its recursive file tree", async () => {
    const bash = createAgentShell({
      current: {
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        jobToken: "token",
      },
    });
    const projectPath = bash.fs.resolvePath(bash.getCwd(), "project");
    await bash.fs.mkdir(`${projectPath}/src/nested`, { recursive: true });
    await bash.fs.writeFile(`${projectPath}/README.md`, "readme", "utf8");
    await bash.fs.writeFile(`${projectPath}/src/index.ts`, "export {};", "utf8");
    await bash.fs.writeFile(`${projectPath}/src/nested/value.txt`, "value", "utf8");

    const responses: Array<{ message: ChatMessage; finishReason: string }> = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-flat",
              type: "function",
              function: {
                name: "list_files",
                arguments: JSON.stringify({ path: "project" }),
              },
            },
            {
              id: "list-tree",
              type: "function",
              function: {
                name: "list_files",
                arguments: JSON.stringify({ path: "project", recursive: true }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "Done." },
        finishReason: "stop",
      },
    ];

    await runAgentPrompt({
      messages: [{ role: "user", content: "List the project" }],
      apiUrl: "http://unused.invalid",
      spaceId: "space",
      jobToken: "token",
      provider,
      bash,
      modelCaller: async (options) => {
        const response = responses.shift();
        if (!response) throw new Error("No mock model response remaining");
        if (responses.length === 0) {
          const toolResults = options.messages.filter(
            (message) => message.role === "tool",
          );
          expect(toolResults.at(-2)?.content).toBe("README.md\nsrc/");
          expect(toolResults.at(-1)?.content).toBe(
            [
              "project/",
              "├── README.md",
              "└── src/",
              "    ├── index.ts",
              "    └── nested/",
              "        └── value.txt",
            ].join("\n"),
          );
        }
        if (response.message.content) {
          await options.onText?.(response.message.content);
        }
        return response;
      },
    });
  });

  it("advertises and directly executes Vektor MCP tools", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ documents: [{ id: "doc-1" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const shellCommands: string[] = [];
    const bash = {
      exec: async (command: string) => {
        shellCommands.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    } as unknown as Bash;
    const responses: Array<{ message: ChatMessage; finishReason: string }> = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "documents-1",
              type: "function",
              function: {
                name: "list_documents",
                arguments: JSON.stringify({ limit: 5 }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "Found it." },
        finishReason: "stop",
      },
    ];
    let callCount = 0;

    try {
      await runAgentPrompt({
        messages: [{ role: "user", content: "List documents" }],
        apiUrl: "http://vektor.test",
        spaceId: "space",
        documentId: "doc-1",
        documentType: "html",
        connectedProviders: [],
        jobToken: "token",
        provider,
        bash,
        modelCaller: async (options) => {
          const toolNames = (options.tools as Array<{ function: { name: string } }>).map(
            (tool) => tool.function.name,
          );
          if (callCount === 0) {
            expect(toolNames).toContain("get_current_document");
            expect(toolNames).toContain("run_workflow");
            expect(toolNames).not.toContain("upload_artifact");
            expect(toolNames).not.toContain("install_extension");
            expect(toolNames).not.toContain("integration_api_request");
          } else {
            expect(options.messages.at(-1)?.content).toBe(
              JSON.stringify({ documents: [{ id: "doc-1" }] }, null, 2),
            );
          }
          callCount += 1;
          const response = responses.shift();
          if (!response) throw new Error("No mock model response remaining");
          if (response.message.content) {
            await options.onText?.(response.message.content);
          }
          return response;
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(shellCommands).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      "http://vektor.test/api/v1/spaces/space/documents?limit=5",
    );
    expect(new Headers(requests[0]?.init?.headers).get("X-Job-Token")).toBe("token");
  });

  it("does not register removed vektor or ai shell commands", async () => {
    const bash = createAgentShell({
      current: {
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        jobToken: "token",
      },
    });

    const vektorResult = await bash.exec("vektor list");
    const aiResult = await bash.exec("ai hello");

    expect(vektorResult.exitCode).toBe(127);
    expect(aiResult.exitCode).toBe(127);
  });

  it("keeps uploads available through the shell command", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ url: "/uploads/report.txt" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const bash = createAgentShell({
      current: {
        apiUrl: "http://vektor.test",
        spaceId: "space",
        jobToken: "token",
      },
    });
    const filePath = bash.fs.resolvePath(bash.getCwd(), "report.txt");
    await bash.fs.writeFile(filePath, "report body", "utf8");

    try {
      const result = await bash.exec("upload report.txt -t text/plain -d document-1");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ url: "/uploads/report.txt" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://vektor.test/api/v1/spaces/space/uploads");
    const form = requests[0]?.init?.body as FormData;
    expect(form.get("filename")).toBe("report.txt");
    expect(form.get("documentId")).toBe("document-1");
    const uploadedFile = form.get("file") as File;
    expect(uploadedFile.type).toStartWith("text/plain");
    expect(await uploadedFile.text()).toBe("report body");
  });

  it("keeps extension installation available through the shell command", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ id: "test-extension" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const bash = createAgentShell({
      current: {
        apiUrl: "http://vektor.test",
        spaceId: "space",
        jobToken: "token",
      },
    });

    try {
      expect((await bash.exec("extension init test-extension")).exitCode).toBe(0);
      expect(
        (
          await bash.exec(
            "cd test-extension && zip ../test-extension.zip manifest.json dist",
          )
        ).exitCode,
      ).toBe(0);
      const result = await bash.exec("extension install test-extension.zip");
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ id: "test-extension" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://vektor.test/api/v1/spaces/space/extensions");
    const form = requests[0]?.init?.body as FormData;
    const extensionFile = form.get("file") as File;
    expect(extensionFile.name).toBe("test-extension.zip");
    expect(extensionFile.type).toBe("application/zip");
  });
});
