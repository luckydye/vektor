import type { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import {
  createAgentShell,
  isOpenCodeZenClaudeModel,
  isOpenCodeZenGPTModel,
  isOpenCodeZenTextOnlyModel,
  runAgentPrompt,
} from "#agent/core.ts";
import { callTool } from "#agent/tools.ts";
import {
  toAnthropicMessages,
  toAnthropicRequestBody,
  toOpenAIFinishReason,
} from "#api/provider/anthropic.ts";
import { toOpenAIResponsesInput } from "#api/provider/openaiCompatible.ts";
import type { ChatMessage } from "#api/provider/types.ts";

const provider = {
  provider: "ollama" as const,
  baseUrl: "http://unused.invalid",
  model: "test",
};

describe("agent model loop", () => {
  it("routes Zen Claude models through the Anthropic-compatible endpoint", () => {
    expect(isOpenCodeZenClaudeModel("claude-sonnet-4-6")).toBe(true);
    expect(isOpenCodeZenClaudeModel("CLAUDE-OPUS-4-6")).toBe(true);
    expect(isOpenCodeZenClaudeModel("gpt-5.4")).toBe(false);
    expect(isOpenCodeZenGPTModel("gpt-5.4")).toBe(true);
    expect(isOpenCodeZenTextOnlyModel("glm-5.2")).toBe(true);
  });

  it("serializes image attachments as Anthropic image blocks", () => {
    const result = toAnthropicMessages([
      {
        role: "user",
        content: "What is shown?",
        images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      },
    ]);

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is shown?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      },
    ]);
  });

  it("uses automatic prompt caching for direct Anthropic proxy requests", () => {
    const body = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(body.cache_control).toEqual({ type: "ephemeral" });
  });

  it("honours a caller-supplied output cap and otherwise defaults generously", () => {
    const explicit = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 64_000,
    });
    expect(explicit.max_tokens).toBe(64_000);

    // Anthropic requires a cap, so an absent one must not fall back to a value
    // small enough to clip a long answer mid-sentence.
    const defaulted = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(defaulted.max_tokens).toBe(32_000);

    // A nonsense value must not be forwarded as-is; Anthropic would reject it.
    const invalid = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 0,
    });
    expect(invalid.max_tokens).toBe(32_000);
  });

  it("forwards reasoning controls only when the caller sets them", () => {
    const tuned = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Hello" }],
      output_config: { effort: "low" },
      thinking: { type: "disabled" },
    });
    expect(tuned.output_config).toEqual({ effort: "low" });
    expect(tuned.thinking).toEqual({ type: "disabled" });

    // Models accept these at different tiers, so an unasked-for default would
    // break spaces configured with a model that predates them.
    const bare = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(bare).not.toHaveProperty("output_config");
    expect(bare).not.toHaveProperty("thinking");
  });

  it("reports a clipped answer as length so callers can resume it", () => {
    // Collapsing this to "stop" makes a truncated answer indistinguishable from
    // a complete one, which is what silently put partial ratings in the results.
    expect(toOpenAIFinishReason("max_tokens")).toBe("length");
    expect(toOpenAIFinishReason("end_turn")).toBe("stop");
    expect(toOpenAIFinishReason("tool_use")).toBe("tool_calls");
    expect(toOpenAIFinishReason(undefined)).toBe("stop");
  });

  it("converts a resumed conversation into alternating Anthropic turns", () => {
    // The chat-completion job resumes a clipped answer by replaying the partial
    // as an assistant turn followed by a user turn asking for the remainder. A
    // trailing assistant turn would be a prefill, which current models reject.
    const body = toAnthropicRequestBody("claude-sonnet-4-6", {
      messages: [
        { role: "system", content: "Rate the page." },
        { role: "user", content: "<page>" },
        {
          role: "assistant",
          content: "**Bewertung**\n🟨 GELB\n\nspart heute Tonnen an Stre",
        },
        { role: "user", content: "Resume from where you stopped." },
      ],
    });

    expect(body.system).toBe("Rate the page.");
    expect(body.messages).toEqual([
      { role: "user", content: "<page>" },
      {
        role: "assistant",
        content: "**Bewertung**\n🟨 GELB\n\nspart heute Tonnen an Stre",
      },
      { role: "user", content: "Resume from where you stopped." },
    ]);
  });

  it("serializes GPT image attachments for the Responses API", () => {
    expect(
      toOpenAIResponsesInput([
        {
          role: "user",
          content: "What is shown?",
          images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is shown?" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      },
    ]);
  });

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

  it("tells the model that explicitly locked and immutable-type documents are readonly", async () => {
    for (const documentContext of [
      { documentType: "document", documentReadonly: true },
      { documentType: "workflow-run", documentReadonly: false },
    ]) {
      await runAgentPrompt({
        messages: [{ role: "user", content: "Edit this document" }],
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        documentId: "doc-1",
        ...documentContext,
        jobToken: "token",
        provider,
        modelCaller: async (options) => {
          expect(options.messages[0]?.content).toContain(
            "The current document is read-only",
          );
          expect(options.messages[0]?.content).not.toContain(
            "## Editing the current document",
          );
          return {
            message: { role: "assistant", content: "This document is read-only." },
            finishReason: "stop",
          };
        },
      });
    }
  });

  it("maps workflow history filters and pagination to the list API contract", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    globalThis.fetch = async (input) => {
      requestUrl = String(input);
      return Response.json({ runs: [], limit: 5, nextCursor: null });
    };

    try {
      await callTool(
        {
          apiUrl: "http://vektor.test",
          spaceId: "space",
          jobToken: "token",
        },
        "list_workflow_runs",
        {
          documentId: "doc-1",
          sourceExtensionId: "extension-1",
          limit: 5,
          cursor: "cursor-1",
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe(
      "http://vektor.test/api/v1/spaces/space/workflows/runs?filterDocumentId=doc-1&sourceExtensionId=extension-1&limit=5&cursor=cursor-1",
    );
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
        documentReadonly: false,
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

  it("rejects unknown tools instead of executing them as shell commands", async () => {
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
              id: "unknown-1",
              type: "function",
              function: {
                name: "js-exec",
                arguments: JSON.stringify({ code: "console.log('unexpected')" }),
              },
            },
          ],
        },
        finishReason: "tool_calls",
      },
      {
        message: { role: "assistant", content: "The requested tool is unavailable." },
        finishReason: "stop",
      },
    ];
    const toolResults: Array<{ content: string; isError: boolean }> = [];

    await runAgentPrompt({
      messages: [{ role: "user", content: "Run the legacy tool" }],
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
      onEvent: (event) => {
        if (event.type === "tool_result") toolResults.push(event);
      },
    });

    expect(shellCommands).toEqual([]);
    expect(toolResults[0]?.isError).toBe(true);
    expect(toolResults[0]?.content).toContain('Unknown tool "js-exec"');
  });

  it("preserves the beginning and tail of truncated tool results", async () => {
    const bash = createAgentShell({
      current: {
        apiUrl: "http://unused.invalid",
        spaceId: "space",
        jobToken: "token",
      },
    });
    const filePath = bash.fs.resolvePath(bash.getCwd(), "large.txt");
    await bash.fs.writeFile(filePath, `BEGIN\n${"x".repeat(8_000)}\nEND`, "utf8");
    const responses: Array<{ message: ChatMessage; finishReason: string }> = [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-large",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "large.txt" }),
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
      messages: [{ role: "user", content: "Read the large file" }],
      apiUrl: "http://unused.invalid",
      spaceId: "space",
      jobToken: "token",
      provider,
      bash,
      modelCaller: async (options) => {
        if (callCount === 1) {
          const modelContent = options.messages.at(-1)?.content ?? "";
          expect(modelContent.startsWith("BEGIN\n")).toBe(true);
          expect(modelContent).toContain("middle characters not shown");
          expect(modelContent.endsWith("\nEND")).toBe(true);
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
    const requested = new URL(String(requests[0]?.url));
    expect(requested.pathname).toBe("/api/v1/spaces/space/uploads");
    expect(requested.searchParams.get("filename")).toBe("report.txt");
    expect(requested.searchParams.get("documentId")).toBe("document-1");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(String(requests[0]?.init?.body)).toBe("report body");
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
